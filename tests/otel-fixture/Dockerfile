FROM python:3.14-alpine

WORKDIR /fixture
COPY examples/generate_otel_traces.py /fixture/generate_otel_traces.py
COPY tests/otel-fixture/seed.py /fixture/seed.py
COPY tests/otel-fixture/rich_fixture.py /fixture/rich_fixture.py
# The fake OTLP receiver of the tests of the server export (the compose service otlp_receiver runs it).
COPY tests/otel-fixture/otlp_receiver.py /fixture/otlp_receiver.py
# The fake AuthZEN PDP of the tests of the access of humans (the compose service access_pdp runs it).
COPY tests/otel-fixture/fake_pdp.py /fixture/fake_pdp.py
COPY tests/clickhouse-init/05-otel-logs-metrics.sql /fixture/05-otel-logs-metrics.sql

ENTRYPOINT ["python3", "/fixture/seed.py"]
