package main

import (
  "context"
  "errors"
  "fmt"
  "log/slog"
  "strings"
  "sync"
  "time"

  clickhouse "github.com/ClickHouse/clickhouse-go/v2"
  clickhouseDriver "github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// querySessionStatus represents the lifecycle status of a query session.
type querySessionStatus string

const (
  querySessionStatusCreated            querySessionStatus = "created"
  querySessionStatusRunning            querySessionStatus = "running"
  querySessionStatusFinished           querySessionStatus = "finished"
  querySessionStatusErrored            querySessionStatus = "error"
  querySessionStatusCanceled           querySessionStatus = "canceled"
  querySessionStatusResultLimitReached querySessionStatus = "result_limit_reached"
)

// IMPORTANT: batching côté producteur (executeQuery)
// => évite de remplir resultEventChannel si le navigateur est plus lent que la DB.
const (
  resultBatchRows   = 200
  resultBatchPeriod = 50 * time.Millisecond
)

// querySession contains state and callbacks for a single query execution.
//
// The session is created by POST /api/query, started on first SSE attach (GET /api/query/stream),
// and can be canceled via POST /api/query/cancel or by closing the SSE connection.
type querySession struct {
  logger *slog.Logger

  queryIdentifier string
  queryText       string
  databaseName    string
  settings        clickhouse.Settings

  createdTime time.Time

  startOnce sync.Once
  mutex     sync.Mutex

  status querySessionStatus

  startedTime  time.Time
  finishedTime time.Time

  cancellationRequestedBeforeStart bool

  executionContext context.Context
  cancelExecution  context.CancelFunc

  nonCriticalEventChannel chan serverSentEventsMessage
  criticalEventChannel    chan serverSentEventsMessage
  resultEventChannel      chan serverSentEventsMessage

  readRowsTotal   uint64
  readBytesTotal  uint64
  totalRowsToRead uint64

  wroteRowsTotal  uint64
  wroteBytesTotal uint64

  userTimeMicrosecondsTotal   int64
  systemTimeMicrosecondsTotal int64

  currentMemoryBytes *int64
  peakMemoryBytes    *int64

  threadLastSeenByIdentifier map[uint64]time.Time
  threadPeakCount            int

  resultPreviewRowLimit int
  resultRowsReturned    int
  resultTruncated       bool
}

// querySessionSnapshot is an immutable view of a session at a specific time.
type querySessionSnapshot struct {
  queryIdentifier string
  status          querySessionStatus

  createdTime  time.Time
  startedTime  time.Time
  finishedTime time.Time

  readRowsTotal   uint64
  readBytesTotal  uint64
  totalRowsToRead uint64

  wroteRowsTotal  uint64
  wroteBytesTotal uint64

  userTimeMicrosecondsTotal   int64
  systemTimeMicrosecondsTotal int64

  currentMemoryBytes *int64
  peakMemoryBytes    *int64

  threadLastSeenByIdentifier map[uint64]time.Time
  threadPeakCount            int
}

// newQuerySession creates a new query session.
func newQuerySession(
  logger *slog.Logger,
  queryIdentifier string,
  queryText string,
  databaseName string,
  settings clickhouse.Settings,
  resultPreviewRowLimit int,
) *querySession {
  return &querySession{
    logger: logger,

    queryIdentifier: queryIdentifier,
    queryText:       queryText,
    databaseName:    databaseName,
    settings:        settings,

    createdTime: time.Now(),
    status:      querySessionStatusCreated,

    nonCriticalEventChannel: make(chan serverSentEventsMessage, 256),
    criticalEventChannel:    make(chan serverSentEventsMessage, 64),
    resultEventChannel:      make(chan serverSentEventsMessage, 2048),

    threadLastSeenByIdentifier: make(map[uint64]time.Time),

    resultPreviewRowLimit: resultPreviewRowLimit,
  }
}

// trySendResult sends result rows; if the client is too slow, we cancel to avoid OOM.
func (session *querySession) trySendResult(message serverSentEventsMessage) {
  select {
  case session.resultEventChannel <- message:
    return
  default:
    session.requestCancellation()
    session.trySendCritical(serverSentEventsMessage{
      eventName: "error",
      payload: map[string]any{
        "query_id": session.queryIdentifier,
        "message":  "client is too slow to consume result stream",
      },
    })
  }
}

// trySendNonCritical sends a message without blocking; if the client is slow, the message is dropped.
func (session *querySession) trySendNonCritical(message serverSentEventsMessage) {
  select {
  case session.nonCriticalEventChannel <- message:
  default:
  }
}

// trySendCritical sends a message without blocking; if the client is slow or disconnected, the message is dropped.
func (session *querySession) trySendCritical(message serverSentEventsMessage) {
  select {
  case session.criticalEventChannel <- message:
  default:
  }
}

func (session *querySession) start(clickhouseConnection clickhouseDriver.Conn, sessionStore *querySessionStore) {
  session.startOnce.Do(func() {
    session.mutex.Lock()
    defer session.mutex.Unlock()

    if session.cancellationRequestedBeforeStart {
      session.trySendCritical(serverSentEventsMessage{
        eventName: "done",
        payload:   session.donePayload(time.Now(), querySessionStatusCanceled, nil),
      })
      return
    }

    session.executionContext, session.cancelExecution = context.WithCancel(context.Background())
    session.startedTime = time.Now()
    session.status = querySessionStatusRunning

    session.logger.Info("query started",
      "query_identifier", session.queryIdentifier,
      "database_name", session.databaseName,
      "query_preview", truncateForLogs(session.queryText, 140),
    )

    go session.executeQuery(clickhouseConnection, sessionStore)
  })
}

// requestCancellation requests cancellation of the query session (best effort).
func (session *querySession) requestCancellation() {
  session.mutex.Lock()
  defer session.mutex.Unlock()

  if session.status == querySessionStatusFinished || session.status == querySessionStatusErrored || session.status == querySessionStatusCanceled {
    return
  }

  if session.cancelExecution != nil {
    session.status = querySessionStatusCanceled
    session.cancelExecution()
    return
  }

  session.cancellationRequestedBeforeStart = true
  session.status = querySessionStatusCanceled
  session.finishedTime = time.Now()
}

// executeQuery runs the ClickHouse query and drains the result stream.
func (session *querySession) executeQuery(clickhouseConnection clickhouseDriver.Conn, sessionStore *querySessionStore) {
  executionStartedTime := time.Now()

  defer func() {
    if r := recover(); r != nil {
      session.finishWithError(time.Now(), fmt.Errorf("panic: %v", r), executionStartedTime)
    }
  }()

  defer func() {
    sessionStore.remove(session.queryIdentifier)
  }()

  baseCtx := session.executionContext
  ctx := clickhouse.Context(
    baseCtx,
    clickhouse.WithSettings(session.settings),
    clickhouse.WithProgress(session.onProgress),
    clickhouse.WithProfileInfo(session.onProfileInfo),
    clickhouse.WithProfileEvents(session.onProfileEvents),
    clickhouse.WithLogs(session.onLog),
  )

  if !isReadOnlyClickhouseStatement(session.queryText) {
    if execError := clickhouseConnection.Exec(ctx, session.queryText); execError != nil {
      session.finishWithError(time.Now(), execError, executionStartedTime)
      return
    }

    session.trySendCritical(serverSentEventsMessage{
      eventName: "result_meta",
      payload: map[string]any{
        "query_id": session.queryIdentifier,
        "columns":  []string{"status"},
        "types":    []string{"String"},
      },
    })

    session.mutex.Lock()
    session.resultRowsReturned = 1
    session.mutex.Unlock()

    session.trySendResult(serverSentEventsMessage{
      eventName: "result_rows",
      payload: map[string]any{
        "query_id": session.queryIdentifier,
        "rows":     [][]string{{"OK"}},
      },
    })

    session.finishSuccessfully(time.Now(), executionStartedTime)
    return
  }

  rows, queryError := clickhouseConnection.Query(ctx, session.queryText)
  if queryError != nil {
    session.finishWithError(time.Now(), queryError, executionStartedTime)
    return
  }
  defer rows.Close()

  columnNames := rows.Columns()
  columnTypes := rows.ColumnTypes()
  if len(columnTypes) != len(columnNames) {
    session.finishWithError(time.Now(), fmt.Errorf("cannot resolve result column types: columns=%d types=%d", len(columnNames), len(columnTypes)), executionStartedTime)
    return
  }

  columnTypeNames := make([]string, len(columnTypes))
  scanDestinations := make([]any, len(columnTypes))
  for i, ct := range columnTypes {
    columnTypeNames[i] = ct.DatabaseTypeName()
    scanDestinations[i] = newScanDestinationFromColumnType(ct)
  }

  session.trySendCritical(serverSentEventsMessage{
    eventName: "result_meta",
    payload: map[string]any{
      "query_id": session.queryIdentifier,
      "columns":  columnNames,
      "types":    columnTypeNames,
    },
  })

  columnCount := len(columnNames)
  valuePointers := scanDestinations

  batch := make([][]string, 0, resultBatchRows)
  lastFlush := time.Now()

  flush := func() bool {
    if len(batch) == 0 {
      return true
    }
    session.trySendResult(serverSentEventsMessage{
      eventName: "result_rows",
      payload: map[string]any{
        "query_id": session.queryIdentifier,
        "rows":     batch,
      },
    })
    batch = make([][]string, 0, resultBatchRows)
    lastFlush = time.Now()

    session.mutex.Lock()
    canceled := session.status == querySessionStatusCanceled
    session.mutex.Unlock()
    return !canceled
  }

  for rows.Next() {
    resetDynamicContainers(scanDestinations)

    if scanError := rows.Scan(scanDestinations...); scanError != nil {
      session.finishWithError(time.Now(), scanError, executionStartedTime)
      return
    }

    formattedRow := make([]string, columnCount)
    for columnIndex := 0; columnIndex < columnCount; columnIndex++ {
      formattedRow[columnIndex] = stringifyScanPointer(valuePointers[columnIndex])
    }

    session.mutex.Lock()
    session.resultRowsReturned++
    reachedLimit := session.resultPreviewRowLimit > 0 && session.resultRowsReturned >= session.resultPreviewRowLimit
    if reachedLimit {
      session.resultTruncated = true
    }
    session.mutex.Unlock()

    batch = append(batch, formattedRow)
    if len(batch) >= resultBatchRows || time.Since(lastFlush) >= resultBatchPeriod {
      if ok := flush(); !ok {
        break
      }
    }

    if reachedLimit {
      _ = flush()
      session.requestCancellation()
      break
    }
  }

  _ = flush()

  if rowsError := rows.Err(); rowsError != nil {
    session.finishWithError(time.Now(), rowsError, executionStartedTime)
    return
  }

  session.finishSuccessfully(time.Now(), executionStartedTime)
}

func (session *querySession) finishSuccessfully(finishedTime time.Time, executionStartedTime time.Time) {
  session.mutex.Lock()
  defer session.mutex.Unlock()

  if session.status == querySessionStatusCanceled && session.resultTruncated {
    session.finishedTime = finishedTime
    session.trySendCritical(serverSentEventsMessage{eventName: "done", payload: session.donePayload(finishedTime, querySessionStatusResultLimitReached, nil)})
    session.logger.Info("query stopped because result limit was reached",
      "query_identifier", session.queryIdentifier,
      "duration", finishedTime.Sub(executionStartedTime),
      "result_rows_returned", session.resultRowsReturned,
    )
    return
  }

  if session.status == querySessionStatusCanceled {
    session.finishedTime = finishedTime
    session.trySendCritical(serverSentEventsMessage{eventName: "done", payload: session.donePayload(finishedTime, querySessionStatusCanceled, nil)})
    session.logger.Info("query canceled (completed after cancellation)",
      "query_identifier", session.queryIdentifier,
      "duration", finishedTime.Sub(executionStartedTime),
    )
    return
  }

  session.status = querySessionStatusFinished
  session.finishedTime = finishedTime

  session.trySendCritical(serverSentEventsMessage{eventName: "done", payload: session.donePayload(finishedTime, querySessionStatusFinished, nil)})
  session.logger.Info("query finished",
    "query_identifier", session.queryIdentifier,
    "duration", finishedTime.Sub(executionStartedTime),
    "read_rows_total", session.readRowsTotal,
    "read_bytes_total", session.readBytesTotal,
    "result_rows_returned", session.resultRowsReturned,
  )
}

func (session *querySession) finishWithError(finishedTime time.Time, executionError error, executionStartedTime time.Time) {
  session.mutex.Lock()
  defer session.mutex.Unlock()

  isCancellation := errors.Is(executionError, context.Canceled)
  if session.status == querySessionStatusCanceled || isCancellation {
    finalStatus := querySessionStatusCanceled
    if session.resultTruncated {
      finalStatus = querySessionStatusResultLimitReached
    }
    session.status = querySessionStatusCanceled
    session.finishedTime = finishedTime
    session.trySendCritical(serverSentEventsMessage{eventName: "done", payload: session.donePayload(finishedTime, finalStatus, executionError)})
    session.logger.Info("query canceled",
      "query_identifier", session.queryIdentifier,
      "duration", finishedTime.Sub(executionStartedTime),
    )
    return
  }

  session.status = querySessionStatusErrored
  session.finishedTime = finishedTime

  session.trySendCritical(serverSentEventsMessage{eventName: "error", payload: buildErrorPayload(session.queryIdentifier, executionError)})
  session.trySendCritical(serverSentEventsMessage{eventName: "done", payload: session.donePayload(finishedTime, querySessionStatusErrored, executionError)})
  session.logger.Info("query errored",
    "query_identifier", session.queryIdentifier,
    "duration", finishedTime.Sub(executionStartedTime),
    "error", executionError.Error(),
  )
}

func (session *querySession) onProfileInfo(profileInfo *clickhouse.ProfileInfo) {
  session.mutex.Lock()
  defer session.mutex.Unlock()

  if profileInfo.Rows > session.readRowsTotal {
    session.readRowsTotal = profileInfo.Rows
  }
  if profileInfo.Bytes > session.readBytesTotal {
    session.readBytesTotal = profileInfo.Bytes
  }
}

func (session *querySession) onProgress(progress *clickhouse.Progress) {
  session.mutex.Lock()
  defer session.mutex.Unlock()

  session.readRowsTotal += progress.Rows
  session.readBytesTotal += progress.Bytes
  session.wroteRowsTotal += progress.WroteRows
  session.wroteBytesTotal += progress.WroteBytes

  if progress.TotalRows > session.totalRowsToRead {
    session.totalRowsToRead = progress.TotalRows
  }
}

func (session *querySession) onProfileEvents(profileEvents []clickhouse.ProfileEvent) {
  now := time.Now()

  session.mutex.Lock()
  defer session.mutex.Unlock()

  for _, e := range profileEvents {
    session.threadLastSeenByIdentifier[e.ThreadID] = now

    switch e.Name {
    case "UserTimeMicroseconds", "OSUserTimeMicroseconds":
      session.userTimeMicrosecondsTotal += e.Value
    case "SystemTimeMicroseconds", "OSSystemTimeMicroseconds":
      session.systemTimeMicrosecondsTotal += e.Value
    }

    if strings.Contains(e.Name, "Memory") || strings.Contains(e.Name, "Mem") {
      v := int64(e.Value)
      if strings.Contains(e.Name, "Tracking") || strings.Contains(e.Name, "Current") || strings.Contains(e.Name, "Usage") {
        session.currentMemoryBytes = &v
      }
      if strings.Contains(e.Name, "Peak") {
        if session.peakMemoryBytes == nil || v > *session.peakMemoryBytes {
          session.peakMemoryBytes = &v
        }
      }
    }
  }
}

func (session *querySession) onLog(logEntry *clickhouse.Log) {
  session.mutex.Lock()
  defer session.mutex.Unlock()

  parsedPeakBytes, parsed := parsePeakMemoryUsageFromLogLine(logEntry.Text)
  if parsed {
    valueAsBytes := int64(parsedPeakBytes)
    session.peakMemoryBytes = &valueAsBytes
  }
}

func (session *querySession) snapshot(now time.Time) querySessionSnapshot {
  session.mutex.Lock()
  defer session.mutex.Unlock()

  threadLastSeenCopy := make(map[uint64]time.Time, len(session.threadLastSeenByIdentifier))
  for threadIdentifier, lastSeen := range session.threadLastSeenByIdentifier {
    threadLastSeenCopy[threadIdentifier] = lastSeen
  }

  return querySessionSnapshot{
    queryIdentifier: session.queryIdentifier,
    status:          session.status,

    createdTime:  session.createdTime,
    startedTime:  session.startedTime,
    finishedTime: session.finishedTime,

    readRowsTotal:   session.readRowsTotal,
    readBytesTotal:  session.readBytesTotal,
    totalRowsToRead: session.totalRowsToRead,

    wroteRowsTotal:  session.wroteRowsTotal,
    wroteBytesTotal: session.wroteBytesTotal,

    userTimeMicrosecondsTotal:   session.userTimeMicrosecondsTotal,
    systemTimeMicrosecondsTotal: session.systemTimeMicrosecondsTotal,

    currentMemoryBytes: session.currentMemoryBytes,
    peakMemoryBytes:    session.peakMemoryBytes,

    threadLastSeenByIdentifier: threadLastSeenCopy,
    threadPeakCount:            session.threadPeakCount,
  }
}

func (session *querySession) donePayload(now time.Time, status querySessionStatus, executionError error) map[string]any {
  elapsedSeconds := 0.0
  if !session.startedTime.IsZero() {
    elapsedSeconds = now.Sub(session.startedTime).Seconds()
  }

  payload := map[string]any{
    "query_id":        session.queryIdentifier,
    "status":          status,
    "elapsed_seconds": elapsedSeconds,
    "read_rows":       session.readRowsTotal,
    "read_bytes":      session.readBytesTotal,

    "result_rows_returned": session.resultRowsReturned,
    "result_truncated":     session.resultTruncated,
  }

  if executionError != nil {
    payload["message"] = executionError.Error()
  }

  return payload
}

func endsWithFormatClause(queryText string) bool {
  trimmed := strings.TrimSpace(queryText)
  if trimmed == "" {
    return false
  }

  for strings.HasSuffix(trimmed, ";") {
    trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, ";"))
  }

  lower := strings.ToLower(trimmed)
  lastFormatIndex := strings.LastIndex(lower, " format ")
  if lastFormatIndex < 0 {
    return false
  }

  after := strings.TrimSpace(lower[lastFormatIndex+len(" format "):])
  if after == "" {
    return false
  }

  parts := strings.Fields(after)
  if len(parts) != 1 {
    return false
  }
  return true
}

func splitTabSeparatedLine(line string) []string {
  if line == "" {
    return []string{""}
  }
  return strings.Split(line, "\t")
}
