FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend source
COPY . .

# Render injects $PORT at runtime; default to 8000 for local use
ENV PORT=8000

EXPOSE $PORT

CMD uvicorn server:app --host 0.0.0.0 --port $PORT
