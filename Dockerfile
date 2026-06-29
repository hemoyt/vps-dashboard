FROM python:3.12-slim

LABEL org.opencontainers.image.title="VPSphere"
LABEL org.opencontainers.image.description="Lightweight VPS management dashboard — file manager, terminal, server stats"

RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080

ENV VPSPHERE_PASSWORD="admin"
ENV VPSPHERE_ROOT="/host"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
