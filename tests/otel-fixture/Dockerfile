FROM python:3.13-alpine

WORKDIR /fixture
COPY examples/generate_otel_traces.py /fixture/generate_otel_traces.py
COPY tests/otel-fixture/seed.py /fixture/seed.py

ENTRYPOINT ["python3", "/fixture/seed.py"]
