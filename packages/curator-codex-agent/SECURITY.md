# Paso 3: Security & Advanced Features

Production-ready security, authentication, and rate limiting.

## 🔒 Security Features

### 1. API Key Authentication

**Bearer Token Authentication**

```bash
curl -X POST http://localhost:3101/mcp \
  -H "Authorization: Bearer sk-your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{...}'
```

**Token Requirements:**
- Must start with `sk-`
- Minimum 20 characters
- Format: `sk-[32+ alphanumeric characters]`

**Endpoints that require auth:**
- All POST/PUT/DELETE endpoints
- `/curator/config`
- `/curator/process`
- `/knowledge/search`
- `/knowledge/reload`

**Endpoints that don't require auth:**
- `GET /health` — health check
- `GET /status` — public status
- `GET /` — API info

### 2. Rate Limiting

**Default:** 100 requests per 15 minutes

```bash
# First request succeeds
curl -X POST http://localhost:3101/mcp \
  -H "Authorization: Bearer sk-..."

# Headers returned:
# RateLimit-Limit: 100
# RateLimit-Remaining: 99
# RateLimit-Reset: 1623456789
```

**After limit exceeded:**
```json
{
  "error": "Too many requests",
  "message": "Rate limit exceeded. Please try again later.",
  "retryAfter": 900
}
```

**Custom rate limits per API key:**
```typescript
const apiKeys = new Map([
  ['sk-free-key', { rateLimit: 50 }],
  ['sk-pro-key', { rateLimit: 1000 }],
]);

const server = new CuratorHttpServer({
  apiConfig: { ... },
  apiKeys // Pass custom limits
});
```

### 3. Input Validation

**Request validation using Zod schemas**

```bash
# Valid request
curl -X POST http://localhost:3101/curator/process \
  -H "Authorization: Bearer sk-..." \
  -d '{"inputPath":"/path","outputPath":"/vault"}'

# Invalid request (missing required field)
curl -X POST http://localhost:3101/curator/process \
  -d '{"inputPath":"/path"}'

# Response:
{
  "error": "Validation failed",
  "details": [
    {
      "field": "outputPath",
      "message": "Required",
      "code": "invalid_type"
    }
  ]
}
```

**Validated schemas:**

| Endpoint | Schema | Validation |
|----------|--------|-----------|
| POST /curator/config | CuratorConfigSchema | inputPath, outputPath required |
| POST /curator/process | CuratorProcessSchema | Both paths optional |
| POST /knowledge/search | KnowledgeSearchSchema | query: 3-500 chars, topK: 1-20 |

### 4. Request Logging

**All requests are logged with:**
- Timestamp
- HTTP method and path
- User ID (from API key)
- Response status
- Duration in milliseconds

```
[2026-06-13T10:30:45.123Z] POST /curator/config (a1b2c3d4e5f6)
[2026-06-13T10:30:46.456Z] POST /curator/config → 200 (1333ms)
```

### 5. Error Handling

**Structured error responses**

```json
{
  "error": "Validation failed",
  "message": "Detailed error message",
  "details": [...],
  "timestamp": "2026-06-13T10:30:45.123Z"
}
```

**HTTP Status Codes:**
| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Validation error (bad input) |
| 401 | Unauthorized (missing/invalid API key) |
| 429 | Rate limited |
| 500 | Server error |

### 6. CORS Support

**Allowed origins:** `*` (configurable)

**Allowed headers:**
- Content-Type
- Authorization
- X-Requested-With
- Accept

**Allowed methods:**
- GET, POST, PUT, DELETE, OPTIONS

## 🔐 API Key Management

### Generate API Keys

In production, generate cryptographically secure keys:

```bash
# Generate a new API key
node -e "console.log('sk-' + require('crypto').randomBytes(32).toString('hex'))"

# Output: sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
```

### Storing Keys

**Development:**
```bash
export CURATOR_API_KEY="sk-..."
npm start
```

**Production:**
```bash
# Store in secure key management (AWS Secrets Manager, HashiCorp Vault, etc.)
export CURATOR_API_KEY=$(aws secretsmanager get-secret-value --secret-id curator-api-key --query SecretString)
npm start
```

### Rotating Keys

```bash
# Old key continues working during rotation period
# New clients use new key
# After rotation period, revoke old key
```

## 📊 Request/Response Examples

### Successful Request

```bash
curl -X POST http://localhost:3101/curator/config \
  -H "Authorization: Bearer sk-test-key-1234567890" \
  -H "Content-Type: application/json" \
  -d '{
    "inputPath": "/path/to/code",
    "outputPath": "/path/to/vault"
  }'
```

**Response:**
```json
{
  "success": true,
  "config": {
    "inputPath": "/path/to/code",
    "outputPath": "/path/to/vault",
    "provider": "deepseek",
    "model": "deepseek-reasoner"
  },
  "meta": {
    "userId": "a1b2c3d4e5f6",
    "timestamp": "2026-06-13T10:30:45.123Z"
  }
}
```

**Headers:**
```
HTTP/1.1 200 OK
Content-Type: application/json
X-Request-ID: a1b2c3d4-e5f6-4g7h-8i9j-0k1l2m3n4o5p
RateLimit-Limit: 100
RateLimit-Remaining: 99
RateLimit-Reset: 1623456789
```

### Failed Authentication

```bash
curl -X POST http://localhost:3101/curator/config \
  -H "Content-Type: application/json" \
  -d '{"inputPath":"/path","outputPath":"/vault"}'
```

**Response:**
```json
{
  "error": "Unauthorized",
  "message": "Missing or invalid Authorization header",
  "expected": "Authorization: Bearer sk-..."
}
```

**Status:** 401 Unauthorized

### Failed Validation

```bash
curl -X POST http://localhost:3101/curator/config \
  -H "Authorization: Bearer sk-test-key-1234567890" \
  -H "Content-Type: application/json" \
  -d '{"inputPath":"/path"}'
```

**Response:**
```json
{
  "error": "Validation failed",
  "details": [
    {
      "field": "outputPath",
      "message": "Required",
      "code": "invalid_type"
    }
  ]
}
```

**Status:** 400 Bad Request

### Rate Limited

```bash
# After 100 requests in 15 minutes...
{
  "error": "Too many requests",
  "message": "Rate limit exceeded. Please try again later.",
  "retryAfter": 900
}
```

**Headers:**
```
HTTP/1.1 429 Too Many Requests
Retry-After: 900
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 1623456789
```

## 🚀 Deployment Checklist

```
✅ API Key authentication enabled
✅ Rate limiting configured (100 req/15min)
✅ Input validation with Zod
✅ Request logging active
✅ Error handling structured
✅ CORS configured
✅ Request IDs for tracing
✅ Status codes proper
```

## 🔧 Configuration

### Environment Variables

```bash
# API Server
CURATOR_HTTP_PORT=3101                    # HTTP port
CURATOR_OUTPUT_PATH=/path/to/vault        # Vault directory
CURATOR_API_KEY=sk-...                    # API key

# Rate Limiting
CURATOR_RATE_LIMIT_WINDOW=900000          # 15 minutes (ms)
CURATOR_RATE_LIMIT_MAX=100                # Requests per window

# Logging
NODE_ENV=production                       # Hide stack traces
LOG_LEVEL=info                            # info, warn, error
```

### Custom Rate Limits (Code)

```typescript
const server = new CuratorHttpServer({
  port: 3101,
  apiConfig: { ... },
  rateLimiter: {
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 100                    // 100 requests
  }
});
```

## 🛡️ Best Practices

1. **Always use HTTPS in production**
   ```bash
   # Use reverse proxy (nginx, Caddy) for TLS
   # Or use node with https module
   ```

2. **Rotate API keys regularly**
   - Monthly rotation recommended
   - Keep old keys working during transition
   - Revoke old keys after transition

3. **Monitor rate limits**
   - Set up alerts for key reaching 80% usage
   - Analyze patterns to detect abuse

4. **Log everything**
   - Keep request logs for audit trail
   - Monitor for suspicious patterns
   - Rotate logs weekly

5. **Use strong secrets**
   - Generate cryptographically secure keys
   - Never commit keys to git
   - Use environment variables or key management services

## 📋 Security Headers

```bash
# All responses include:
X-Request-ID: Unique request identifier for tracing
RateLimit-Limit: Total requests allowed
RateLimit-Remaining: Requests remaining in window
RateLimit-Reset: Unix timestamp when limit resets
```

## 🚨 Security Incident Response

**If API key is compromised:**

```bash
# 1. Revoke the key immediately
export REVOKED_KEYS=["sk-compromised-key"]

# 2. Rotate to new key
export CURATOR_API_KEY="sk-new-secure-key"

# 3. Review logs for unauthorized access
# grep -r "sk-compromised-key" logs/

# 4. Update all clients with new key
```

## ✅ Paso 3 Complete

```
✅ Authentication (Bearer tokens)
✅ Rate Limiting (100 req/15min)
✅ Input Validation (Zod schemas)
✅ Error Handling (structured responses)
✅ Request Logging (all endpoints)
✅ CORS (configurable)
✅ Request Tracking (UUID per request)
✅ Production-ready security
```

## 🎯 Next Steps

- Deploy with reverse proxy (nginx/Caddy) for HTTPS
- Set up monitoring/alerting for rate limits
- Implement API key rotation procedure
- Add webhook signatures for n8n integration
- Create client SDKs (Python, JavaScript, Go)

---

**Your API is now production-ready and secure.** 🎉
