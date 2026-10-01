FROM python:3.13-alpine

WORKDIR /fixture
COPY examples/generate_otel_traces.py /fixture/generate_otel_traces.py
COPY tests/otel-fixture/seed.py /fixture/seed.py
COPY tests/otel-fixture/rich_fixture.py /fixture/rich_fixture.py
COPY tests/clickhouse-init/05-otel-logs-metrics.sql /fixture/05-otel-logs-metrics.sql

ENTRYPOINT ["python3", "/fixture/seed.py"]
