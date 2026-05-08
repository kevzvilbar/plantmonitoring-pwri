FROM python:3.12-slim

WORKDIR /app

# Copy backend dependencies first (layer cache)
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ .

# Render injects $PORT at runtime; default 8000 for local use
ENV PORT=8000

EXPOSE $PORT

CMD uvicorn server:app --host 0.0.0.0 --port $PORT
