package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	clickhouse "github.com/ClickHouse/clickhouse-go/v2"
)

// embeddedStaticFiles contains the static frontend assets.
//
//go:embed static/*
var embeddedStaticFiles embed.FS

// dashboardServer owns HTTP handlers and shared dependencies.
type dashboardServer struct {
	logger *slog.Logger

	configuration applicationConfiguration

	clickhouseConnectionManager *clickhouseConnectionManager
	querySessionStore           *querySessionStore
}

// newDashboardServer creates a new dashboard server.
func newDashboardServer(
	logger *slog.Logger,
	configuration applicationConfiguration,
	clickhouseConnectionManager *clickhouseConnectionManager,
	querySessionStore *querySessionStore,
) *dashboardServer {
	return &dashboardServer{
		logger: logger,

		configuration: configuration,

		clickhouseConnectionManager: clickhouseConnectionManager,
		querySessionStore:           querySessionStore,
	}
}

// serve starts the HTTP server.
func (server *dashboardServer) serve() error {
	staticFilesSubFileSystem, subFileSystemError := fs.Sub(embeddedStaticFiles, "static")
	if subFileSystemError != nil {
		return subFileSystemError
	}

	multiplexer := http.NewServeMux()

	// Serve the UI at / and static assets at /static/*.
	multiplexer.HandleFunc("/", func(httpResponseWriter http.ResponseWriter, httpRequest *http.Request) {
		if httpRequest.URL.Path != "/" {
			http.NotFound(httpResponseWriter, httpRequest)
			return
		}

		file, err := staticFilesSubFileSystem.Open("index.html")
		if err != nil {
			http.Error(httpResponseWriter, "index.html not found", http.StatusInternalServerError)
			return
		}
		defer file.Close()

		httpResponseWriter.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.Copy(httpResponseWriter, file)
	})

	multiplexer.Handle(
		"/static/",
		http.StripPrefix("/static/", http.FileServer(http.FS(staticFilesSubFileSystem))),
	)

	// API endpoints.
	multiplexer.Handle("/api/query", http.HandlerFunc(server.handleCreateQuery))
	multiplexer.Handle("/api/query/stream", http.HandlerFunc(server.handleQueryStream))
	multiplexer.Handle("/api/query/cancel", http.HandlerFunc(server.handleCancelQuery))

	// Health check.
	multiplexer.Handle("/healthz", http.HandlerFunc(server.handleHealthz))


	httpServer := &http.Server{
		Addr:              server.configuration.serverListenAddress,
		Handler:           multiplexer,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      0, // SSE and long queries require long-lived responses.
		IdleTimeout:       60 * time.Second,
	}

	server.logger.Info("http server listening", "address", server.configuration.serverListenAddress)
	return httpServer.ListenAndServe()
}

// createQueryRequest is the request payload for POST /api/query.
type createQueryRequest struct {
	QueryText    string         `json:"sql"`
	DatabaseName string         `json:"database,omitempty"`
	Settings     map[string]any `json:"settings,omitempty"`
}

func (server *dashboardServer) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErrorJson(w, http.StatusMethodNotAllowed, "method_not_allowed", "Only GET is allowed.")
		return
	}

	// Database name fallback
	databaseName := strings.TrimSpace(server.configuration.clickhouseDatabaseName)
	if databaseName == "" {
		databaseName = "default"
	}

	// Short timeout so healthz never hangs
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	conn, err := server.clickhouseConnectionManager.connectionForDatabase(databaseName)
	if err != nil {
		writeJson(w, http.StatusServiceUnavailable, map[string]any{
			"status": "not_ready",
			"clickhouse": map[string]any{
				"ok":    false,
				"error": err.Error(),
			},
		})
		return
	}

	if err := conn.Ping(ctx); err != nil {
		// Best-effort: force a reconnect next time
		server.clickhouseConnectionManager.invalidateDatabaseConnection(databaseName)

		writeJson(w, http.StatusServiceUnavailable, map[string]any{
			"status": "not_ready",
			"clickhouse": map[string]any{
				"ok":    false,
				"error": err.Error(),
			},
		})
		return
	}

	writeJson(w, http.StatusOK, map[string]any{
		"status": "ok",
		"clickhouse": map[string]any{
			"ok":       true,
			"database": databaseName,
		},
	})
}


// handleCreateQuery handles POST /api/query.
func (server *dashboardServer) handleCreateQuery(httpResponseWriter http.ResponseWriter, httpRequest *http.Request) {
	if httpRequest.Method != http.MethodPost {
		writeErrorJson(httpResponseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "Only POST is allowed.")
		return
	}

	requestBodyBytesReader := http.MaxBytesReader(httpResponseWriter, httpRequest.Body, 1<<20)
	defer requestBodyBytesReader.Close()

	var requestPayload createQueryRequest
	decodeError := json.NewDecoder(requestBodyBytesReader).Decode(&requestPayload)
	if decodeError != nil {
		writeErrorJson(httpResponseWriter, http.StatusBadRequest, "invalid_json", "Invalid JSON request body.")
		return
	}

	queryText := strings.TrimSpace(requestPayload.QueryText)
	if queryText == "" {
		writeErrorJson(httpResponseWriter, http.StatusBadRequest, "missing_sql", "Missing SQL text.")
		return
	}

	databaseName := strings.TrimSpace(requestPayload.DatabaseName)
	if databaseName == "" {
		databaseName = server.configuration.clickhouseDatabaseName
	}

	queryIdentifier, identifierError := generateQueryIdentifier()
	if identifierError != nil {
		writeErrorJson(httpResponseWriter, http.StatusInternalServerError, "server_error", "Failed to generate query identifier.")
		return
	}

	settings := buildDefaultQuerySettings(server.configuration)
	for settingKey, settingValue := range requestPayload.Settings {
		settings[settingKey] = settingValue
	}

	session := newQuerySession(
		server.logger,
		queryIdentifier,
		queryText,
		databaseName,
		settings,
		server.configuration.defaultResultPreviewRows,
	)

	server.querySessionStore.create(session)

	writeJson(httpResponseWriter, http.StatusOK, map[string]any{
		"query_id":   queryIdentifier,
		"stream_url": fmt.Sprintf("api/query/stream?query_id=%s", queryIdentifier),
	})
}

// buildDefaultQuerySettings returns ClickHouse settings applied to every query by default.
func buildDefaultQuerySettings(configuration applicationConfiguration) clickhouse.Settings {
	return clickhouse.Settings{
		// IMPORTANT: tu as dit que tu veux autoriser DELETE/DDL => pas de readonly.
		// "readonly": 1,

		// Guardrails
		"max_execution_time": configuration.defaultMaximumExecutionTimeSeconds,
		"max_result_rows":    configuration.defaultMaximumResultRows,
		"max_result_bytes":   configuration.defaultMaximumResultBytes,
		"send_logs_level":    "information",
	}
}

// cancelQueryRequest is the request payload for POST /api/query/cancel.
type cancelQueryRequest struct {
	QueryIdentifier string `json:"query_id"`
}

// handleCancelQuery handles POST /api/query/cancel.
func (server *dashboardServer) handleCancelQuery(httpResponseWriter http.ResponseWriter, httpRequest *http.Request) {
	if httpRequest.Method != http.MethodPost {
		writeErrorJson(httpResponseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "Only POST is allowed.")
		return
	}

	requestBodyBytesReader := http.MaxBytesReader(httpResponseWriter, httpRequest.Body, 1<<20)
	defer requestBodyBytesReader.Close()

	var requestPayload cancelQueryRequest
	decoder := json.NewDecoder(requestBodyBytesReader)
	decoder.DisallowUnknownFields()
	if decodeError := decoder.Decode(&requestPayload); decodeError != nil {
		writeErrorJson(httpResponseWriter, http.StatusBadRequest, "invalid_json", decodeError.Error())
		return
	}

	queryIdentifier := strings.TrimSpace(requestPayload.QueryIdentifier)
	if queryIdentifier == "" {
		writeErrorJson(httpResponseWriter, http.StatusBadRequest, "missing_query_id", "Field 'query_id' must not be empty.")
		return
	}

	session, exists := server.querySessionStore.get(queryIdentifier)
	if !exists {
		writeErrorJson(httpResponseWriter, http.StatusNotFound, "not_found", "Unknown query_id.")
		return
	}

	session.requestCancellation()

	// Best effort: also execute KILL QUERY using the administrator connection if possible.
	go server.killQueryBestEffort(queryIdentifier, session.databaseName)

	writeJson(httpResponseWriter, http.StatusOK, map[string]any{
		"query_id": queryIdentifier,
		"status":   "cancel_requested",
	})
}

// killQueryBestEffort attempts to stop a running query using KILL QUERY.
func (server *dashboardServer) killQueryBestEffort(queryIdentifier string, databaseName string) {
	connection, connectionError := server.clickhouseConnectionManager.administratorConnectionForControlPlane(databaseName)
	if connectionError != nil {
		server.logger.Warn("unable to open administrator connection for KILL QUERY", "query_identifier", queryIdentifier, "error", connectionError.Error())
		return
	}

	if !isSafeQueryIdentifier(queryIdentifier) {
		server.logger.Warn("refusing to execute KILL QUERY: unsafe query identifier", "query_identifier", queryIdentifier)
		return
	}

	requestContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	killStatement := fmt.Sprintf("KILL QUERY WHERE query_id = '%s' SYNC", queryIdentifier)
	executionError := connection.Exec(requestContext, killStatement)
	if executionError != nil {
		server.logger.Warn("KILL QUERY failed", "query_identifier", queryIdentifier, "error", executionError.Error())
		return
	}
	server.logger.Info("KILL QUERY executed", "query_identifier", queryIdentifier)
}

// handleQueryStream handles GET /api/query/stream?query_id=... and streams SSE events.
func (server *dashboardServer) handleQueryStream(httpResponseWriter http.ResponseWriter, httpRequest *http.Request) {
	if httpRequest.Method != http.MethodGet {
		writeErrorJson(httpResponseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "Only GET is allowed.")
		return
	}

	queryIdentifier := strings.TrimSpace(httpRequest.URL.Query().Get("query_id"))
	if queryIdentifier == "" {
		writeErrorJson(httpResponseWriter, http.StatusBadRequest, "missing_query_id", "Missing query_id query parameter.")
		return
	}

	session, exists := server.querySessionStore.get(queryIdentifier)
	if !exists {
		writeErrorJson(httpResponseWriter, http.StatusNotFound, "not_found", "Unknown query_id.")
		return
	}

	flusher, supportsFlushing := httpResponseWriter.(http.Flusher)
	if !supportsFlushing {
		writeErrorJson(httpResponseWriter, http.StatusInternalServerError, "server_error", "ResponseWriter does not support flushing (required for SSE).")
		return
	}

	httpResponseWriter.Header().Set("Content-Type", "text/event-stream")
	httpResponseWriter.Header().Set("Cache-Control", "no-cache")
	httpResponseWriter.Header().Set("Connection", "keep-alive")
	httpResponseWriter.Header().Set("X-Accel-Buffering", "no")

	_ = writeServerSentEvent(httpResponseWriter, flusher, "meta", map[string]any{
		"query_id": queryIdentifier,
		"status":   "connected",
	})

	clickhouseConnection, connectionError := server.clickhouseConnectionManager.connectionForDatabase(session.databaseName)
	if connectionError != nil {
		_ = writeServerSentEvent(httpResponseWriter, flusher, "error", buildErrorPayload(queryIdentifier, connectionError))
		_ = writeServerSentEvent(httpResponseWriter, flusher, "done", map[string]any{
			"query_id": queryIdentifier,
			"status":   "error",
			"message":  connectionError.Error(),
		})
		return
	}

	// Start query (async).
	session.start(clickhouseConnection, server.querySessionStore)

	// Cancel if client disconnects.
	go func() {
		<-httpRequest.Context().Done()
		session.requestCancellation()
	}()

	// Publish cadence: 4 Hz SSE.
	publishTicker := time.NewTicker(250 * time.Millisecond)
	defer publishTicker.Stop()

	keepAliveTicker := time.NewTicker(15 * time.Second)
	defer keepAliveTicker.Stop()

	// ---- metrics state (inst + max) ----
	var (
		prevPublishTime time.Time
		prevReadRows    uint64
		prevReadBytes   uint64
		prevCPUSeconds  float64

		cpuInstMaxCenti int64
		threadPeakMax   int
		peakMemMaxBytes *int64

		prevTickElapsedMs int64
		prevSampleRB      int64
		prevSampleCPU     int64
		prevSampleMem     int64
		prevSampleThr     int64
	)

	updateMaxPeakMem := func(v *int64) {
		if v == nil {
			return
		}
		if peakMemMaxBytes == nil || *v > *peakMemMaxBytes {
			copied := *v
			peakMemMaxBytes = &copied
		}
	}

	clampInt64 := func(v int64) int64 {
		if v < 0 {
			return 0
		}
		return v
	}

	roundFloatToInt64 := func(v float64) int64 {
		if v != v || v > 9e18 || v < -9e18 {
			return 0
		}
		if v >= 0 {
			return int64(v + 0.5)
		}
		return int64(v - 0.5)
	}

	// Build the *single* tick payload as an ARRAY (no dict), with packed samples.
	buildTickPayload := func(now time.Time, snap querySessionSnapshot) []any {
		elapsedSeconds := 0.0
		if !snap.startedTime.IsZero() {
			elapsedSeconds = now.Sub(snap.startedTime).Seconds()
		}
		elapsedMs := int64(elapsedSeconds * 1000.0)

		percent, known := calculateProgressPercent(0, snap.readBytesTotal, snap.totalRowsToRead, snap.readRowsTotal)
		percentCenti := int64(-1)
		knownInt := int64(0)
		if known {
			knownInt = 1
			percentCenti = roundFloatToInt64(percent * 100.0)
		}

		// resource inst/max
		cpuSeconds := float64(snap.userTimeMicrosecondsTotal+snap.systemTimeMicrosecondsTotal) / 1e6

		threadCountCurrent, threadCountPeak := estimateThreadCounts(now, snap.threadLastSeenByIdentifier, 2*time.Second, snap.threadPeakCount)
		if threadCountPeak > threadPeakMax {
			threadPeakMax = threadCountPeak
		}

		updateMaxPeakMem(snap.peakMemoryBytes)

		rowsPerSecondInst := 0.0
		bytesPerSecondInst := 0.0
		cpuInstPercent := 0.0
		if !prevPublishTime.IsZero() {
			dt := now.Sub(prevPublishTime).Seconds()
			if dt > 0 {
				rowsPerSecondInst = float64(snap.readRowsTotal-prevReadRows) / dt
				bytesPerSecondInst = float64(snap.readBytesTotal-prevReadBytes) / dt
				cpuDelta := cpuSeconds - prevCPUSeconds
				if cpuDelta < 0 {
					cpuDelta = 0
				}
				cpuInstPercent = (cpuDelta / dt) * 100.0
			}
		}

		cpuCenti := roundFloatToInt64(cpuInstPercent * 100.0)
		if cpuCenti > cpuInstMaxCenti {
			cpuInstMaxCenti = cpuCenti
		}

		prevPublishTime = now
		prevReadRows = snap.readRowsTotal
		prevReadBytes = snap.readBytesTotal
		prevCPUSeconds = cpuSeconds

		memInst := int64(-1)
		if snap.currentMemoryBytes != nil {
			memInst = *snap.currentMemoryBytes
		}
		memMax := int64(-1)
		if peakMemMaxBytes != nil {
			memMax = *peakMemMaxBytes
		}

		rowsPerSecInt := roundFloatToInt64(rowsPerSecondInst)
		bytesPerSecInt := roundFloatToInt64(bytesPerSecondInst)

		thrInst := int64(threadCountCurrent)
		thrMax := int64(threadPeakMax)

		samples := make([][]int64, 0, 32)
		if prevTickElapsedMs > 0 && elapsedMs > prevTickElapsedMs {
			step := int64(10)
			dtMs := elapsedMs - prevTickElapsedMs
			count := int(dtMs / step)
			if count > 0 {
				if count > 5000 {
					count = 5000
					step = dtMs / int64(count)
					if step <= 0 {
						step = 10
					}
				}

				curRB := int64(snap.readBytesTotal)
				curCPU := cpuCenti
				curMem := memInst
				curThr := thrInst

				den := float64(elapsedMs - prevTickElapsedMs)
				if den <= 0 {
					den = 1
				}

				for i := 1; i <= count; i++ {
					tt := prevTickElapsedMs + int64(i)*step
					if tt > elapsedMs {
						break
					}
					ratio := float64(tt-prevTickElapsedMs) / den
					lerp := func(a, b int64) int64 {
						return a + roundFloatToInt64(float64(b-a)*ratio)
					}

					rb := clampInt64(lerp(prevSampleRB, curRB))
					cpu := lerp(prevSampleCPU, curCPU)
					mem := lerp(prevSampleMem, curMem)
					thr := lerp(prevSampleThr, curThr)

					samples = append(samples, []int64{tt, rb, cpu, mem, thr})
				}

				// advance prev sample anchors
				prevSampleRB = curRB
				prevSampleCPU = curCPU
				prevSampleMem = curMem
				prevSampleThr = curThr
			}
		} else if prevTickElapsedMs == 0 {
			// initialize anchors on the first tick
			prevSampleRB = int64(snap.readBytesTotal)
			prevSampleCPU = cpuCenti
			prevSampleMem = memInst
			prevSampleThr = thrInst
		}
		prevTickElapsedMs = elapsedMs

		// Convert samples to []any for JSON
		var samplesAny any = nil
		if len(samples) > 0 {
			out := make([][]int64, 0, len(samples))
			for _, s := range samples {
				out = append(out, s)
			}
			samplesAny = out
		}

		// tick array layout:
		// [
		//   0 t_ms,
		//   1 percent_centi_or_-1, 2 percent_known(0/1),
		//   3 read_rows, 4 read_bytes, 5 total_rows_to_read,
		//   6 rows_per_s, 7 bytes_per_s,
		//   8 cpu_centi, 9 cpu_max_centi,
		//   10 mem_bytes_or_-1, 11 mem_max_bytes_or_-1,
		//   12 threads, 13 threads_max,
		//   14 samples([[t_ms, rb, cpu_centi, mem_or_-1, thr],...]) or null
		// ]
		return []any{
			elapsedMs,
			percentCenti, knownInt,
			int64(snap.readRowsTotal), int64(snap.readBytesTotal), int64(snap.totalRowsToRead),
			rowsPerSecInt, bytesPerSecInt,
			cpuCenti, cpuInstMaxCenti,
			memInst, memMax,
			thrInst, thrMax,
			samplesAny,
		}
	}

	// Results are already batched on the producer side (query_session.go) as "result_rows".
	// Here we just forward SSE events as-is.
	drainResultChannel := func() {
		for {
			select {
			case resultMessage := <-session.resultEventChannel:
				_ = writeServerSentEvent(httpResponseWriter, flusher, resultMessage.eventName, resultMessage.payload)
			default:
				return
			}
		}
	}

	// Initial publish.
	now := time.Now()
	snap := session.snapshot(now)
	_ = writeServerSentEvent(httpResponseWriter, flusher, "tick", buildTickPayload(now, snap))

	for {
		select {
		case resultMessage := <-session.resultEventChannel:
			_ = writeServerSentEvent(httpResponseWriter, flusher, resultMessage.eventName, resultMessage.payload)

		case criticalMessage := <-session.criticalEventChannel:
			if criticalMessage.eventName == "done" {
				// Drain any buffered result events first.
				drainResultChannel()

				// Final tick snapshot (after query end).
				finalNow := time.Now()
				finalSnap := session.snapshot(finalNow)
				_ = writeServerSentEvent(httpResponseWriter, flusher, "tick", buildTickPayload(finalNow, finalSnap))
				_ = writeServerSentEvent(httpResponseWriter, flusher, "done", criticalMessage.payload)
				return
			}

			_ = writeServerSentEvent(httpResponseWriter, flusher, criticalMessage.eventName, criticalMessage.payload)

		case <-publishTicker.C:
			t := time.Now()
			s := session.snapshot(t)
			_ = writeServerSentEvent(httpResponseWriter, flusher, "tick", buildTickPayload(t, s))

		case <-keepAliveTicker.C:
			_ = writeServerSentEvent(httpResponseWriter, flusher, "keepalive", map[string]any{
				"query_id": queryIdentifier,
				"time":     time.Now().Format(time.RFC3339),
			})

		case <-httpRequest.Context().Done():
			session.requestCancellation()
			return

		case <-session.nonCriticalEventChannel:
			// no-op
		}
	}
}

// persistThreadPeakCount stores the latest peak thread count in the session.
func (server *dashboardServer) persistThreadPeakCount(session *querySession, observedPeak int) {
	session.mutex.Lock()
	defer session.mutex.Unlock()

	if observedPeak > session.threadPeakCount {
		session.threadPeakCount = observedPeak
	}
}

// writeServerSentEvent writes a single SSE event and flushes.
func writeServerSentEvent(httpResponseWriter http.ResponseWriter, flusher http.Flusher, eventName string, payload any) error {
	serializedPayloadBytes, marshalError := json.Marshal(payload)
	if marshalError != nil {
		return marshalError
	}

	_, _ = fmt.Fprintf(httpResponseWriter, "event: %s\n", eventName)
	_, _ = fmt.Fprintf(httpResponseWriter, "data: %s\n\n", string(serializedPayloadBytes))
	flusher.Flush()
	return nil
}
