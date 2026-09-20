# Use Python 3.11 slim image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Ensure attachments directory exists
RUN mkdir -p attachments

# Set environment variables (Cloud Run이 PORT 주입)
ENV PORT=8080
ENV BUCKET_NAME=time-logger-data-hwang

# 0.0.0.0 바인딩 + 셸 형식 CMD(컨테이너 기동 시 Cloud Run의 PORT 확장)
CMD exec gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 0 app:app
