FROM python:3.14-slim
WORKDIR /tests
COPY test/api/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY test/api /tests
CMD ["python", "/tests/main.py", "test"]
