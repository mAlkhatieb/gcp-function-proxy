# gcp-function-proxy

A private HTTP/HTTPS proxy server built with Google Cloud Functions and TypeScript. Forward and route HTTP requests securely through GCP serverless infrastructure with API key authentication.

## How It Works

```
Client ──▶ Cloud Function (auth + header filtering) ──▶ Target Server
  ◀──────────────── response forwarded back ◀──────────────────
```

The client sends a request with:

- `X-API-Key` — authentication header
- `X-Target-Host` — the upstream server to proxy to (e.g. `https://api.example.com`)

The function validates auth, strips internal headers, forwards the request to the target, and returns the response.

## Project Structure

```
├── src/
│   └── index.ts        # Cloud Function entry point
├── dist/               # Compiled JS (generated)
├── package.json
├── tsconfig.json
└── .env.example
```

## Environment Variables

| Variable  | Description                                      |
| --------- | ------------------------------------------------ |
| `API_KEY` | Secret key that clients must send in `X-API-Key` |

## Local Development

```bash
# Install dependencies
npm install

# Build & run locally (port 8080)
API_KEY=your-secret-key npm start
```

## Deployment

```bash
npm run build

gcloud functions deploy proxy \
  --runtime nodejs22 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point proxy \
  --source . \
  --set-env-vars API_KEY=your-secret-key \
  --region us-central1 \
  --no-gen2
```

> **Note**: `--allow-unauthenticated` permits public HTTP access — authentication is handled at the application level via the `X-API-Key` header. For an additional layer, remove this flag and use GCP IAM.

## Usage

```bash
# GET request
curl -X GET \
  -H "X-API-Key: your-secret-key" \
  -H "X-Target-Host: https://httpbin.org" \
  https://YOUR_FUNCTION_URL/get

# POST request with JSON body
curl -X POST \
  -H "X-API-Key: your-secret-key" \
  -H "X-Target-Host: https://httpbin.org" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}' \
  https://YOUR_FUNCTION_URL/post
```

## Error Responses

| Status | Meaning                             |
| ------ | ----------------------------------- |
| `401`  | Missing or invalid `X-API-Key`      |
| `400`  | Missing or invalid `X-Target-Host`  |
| `502`  | Could not reach the upstream server |

## License

MIT
