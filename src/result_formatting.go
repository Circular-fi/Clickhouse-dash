package main

import (
  "encoding/hex"
  "encoding/json"
  "fmt"
  "math/big"
  "reflect"
  "strings"
  "time"

  clickhouseDriver "github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type dynamicOrderedMap struct {
  m map[string]any
}

func newDynamicOrderedMap() *dynamicOrderedMap {
  return &dynamicOrderedMap{m: make(map[string]any)}
}

func (d *dynamicOrderedMap) Reset() {
  if d.m == nil {
    d.m = make(map[string]any)
    return
  }
  for k := range d.m {
    delete(d.m, k)
  }
}

func (d *dynamicOrderedMap) Put(key any, value any) {
  if d.m == nil {
    d.m = make(map[string]any)
  }
  d.m[fmt.Sprint(key)] = value
}

func (d *dynamicOrderedMap) Get(key any) (any, bool) {
  if d.m == nil {
    return nil, false
  }
  v, ok := d.m[fmt.Sprint(key)]
  return v, ok
}

func (d *dynamicOrderedMap) Keys() <-chan any {
  ch := make(chan any)
  go func() {
    if d.m != nil {
      for k := range d.m {
        ch <- k
      }
    }
    close(ch)
  }()
  return ch
}

func (d dynamicOrderedMap) MarshalJSON() ([]byte, error) {
	normalized := make(map[string]any, len(d.m))
	for k, v := range d.m {
		normalized[k] = normalizeForJSON(v)
	}
	return json.Marshal(normalized)
}

func unwrapTypeName(databaseTypeName string) string {
  s := strings.ToLower(strings.TrimSpace(databaseTypeName))
  for {
    if strings.HasPrefix(s, "nullable(") && strings.HasSuffix(s, ")") {
      s = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(s, "nullable("), ")"))
      continue
    }
    if strings.HasPrefix(s, "lowcardinality(") && strings.HasSuffix(s, ")") {
      s = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(s, "lowcardinality("), ")"))
      continue
    }
    break
  }
  return s
}

func newScanDestinationFromColumnType(ct clickhouseDriver.ColumnType) any {
  normalized := unwrapTypeName(ct.DatabaseTypeName())
  if strings.HasPrefix(normalized, "map(") {
    return newDynamicOrderedMap()
  }

  st := ct.ScanType()
  if st == nil {
    var v any
    return &v
  }
  return reflect.New(st).Interface()
}

func resetDynamicContainers(scanDestinations []any) {
  for _, d := range scanDestinations {
    if om, ok := d.(*dynamicOrderedMap); ok {
      om.Reset()
    }
  }
}

func stringifyScanPointer(pointer any) string {
  if pointer == nil {
    return "NULL"
  }

  rv := reflect.ValueOf(pointer)
  for rv.IsValid() && (rv.Kind() == reflect.Pointer || rv.Kind() == reflect.Interface) {
    if rv.IsNil() {
      return "NULL"
    }
    rv = rv.Elem()
  }

  if !rv.IsValid() {
    return "NULL"
  }

  return formatResultValue(rv.Interface())
}

func formatResultValue(value any) string {
	if value == nil {
		return "NULL"
	}

	if m, ok := value.(json.Marshaler); ok {
		if b, err := m.MarshalJSON(); err == nil {
			return string(b)
		}
	}

	switch v := value.(type) {
	case string:
		return v
	case []byte:
		return hex.EncodeToString(v)
	case time.Time:
		return v.Format(time.RFC3339Nano)
	case big.Int:
		return v.String()
	case *big.Int:
		if v == nil {
			return "NULL"
		}
		return v.String()
	default:
		rv := reflect.ValueOf(value)
		if rv.IsValid() {
			switch rv.Kind() {
			case reflect.Slice, reflect.Array, reflect.Map, reflect.Struct:
				normalized := normalizeForJSON(value)
				if b, err := json.Marshal(normalized); err == nil {
					return string(b)
				}
			}
		}
		if s, ok := value.(fmt.Stringer); ok {
			return s.String()
		}
		return fmt.Sprint(value)
	}
}


func normalizeForJSON(v any) any {
  if v == nil {
    return nil
  }

  rv := reflect.ValueOf(v)
  for rv.IsValid() && (rv.Kind() == reflect.Pointer || rv.Kind() == reflect.Interface) {
    if rv.IsNil() {
      return nil
    }
    rv = rv.Elem()
  }
  if !rv.IsValid() {
    return nil
  }

  if bi, ok := rv.Interface().(big.Int); ok {
    return bi.String()
  }
  if bip, ok := rv.Interface().(*big.Int); ok {
    if bip == nil {
      return nil
    }
    return bip.String()
  }
  if t, ok := rv.Interface().(time.Time); ok {
    return t.Format(time.RFC3339Nano)
  }
  if b, ok := rv.Interface().([]byte); ok {
    return hex.EncodeToString(b)
  }

  switch rv.Kind() {
  case reflect.Slice, reflect.Array:
    n := rv.Len()
    out := make([]any, n)
    for i := 0; i < n; i++ {
      out[i] = normalizeForJSON(rv.Index(i).Interface())
    }
    return out

  case reflect.Map:
    out := make(map[string]any, rv.Len())
    iter := rv.MapRange()
    for iter.Next() {
      k := fmt.Sprint(iter.Key().Interface())
      out[k] = normalizeForJSON(iter.Value().Interface())
    }
    return out

  case reflect.Struct:
    rt := rv.Type()
    out := make(map[string]any)
    for i := 0; i < rt.NumField(); i++ {
      f := rt.Field(i)
      if f.PkgPath != "" {
        continue
      }
      name := f.Name
      if tag := f.Tag.Get("json"); tag != "" {
        parts := strings.Split(tag, ",")
        if parts[0] == "-" {
          continue
        }
        if parts[0] != "" {
          name = parts[0]
        }
      }
      out[name] = normalizeForJSON(rv.Field(i).Interface())
    }
    return out

  default:
    return rv.Interface()
  }
}
