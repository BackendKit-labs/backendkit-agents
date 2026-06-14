# HTTP Event Trigger

The HTTP trigger server lets external systems (n8n, ERPs, HR platforms, CI/CD pipelines) start orchestrations and poll their status via a simple REST API — no Claude Desktop or MCP client required.

## Activation

Set both environment variables to enable the HTTP server. The MCP server starts alongside it (on stdio).

```bash
ORCHESTRATOR_CONFIG=/path/to/orchestrator.yaml \
ORCHESTRATOR_HTTP_PORT=3000 \
ORCHESTRATOR_API_KEY=change-me-in-production \
orchestrator-agent
```

If either `ORCHESTRATOR_HTTP_PORT` or `ORCHESTRATOR_CONFIG` is missing, the HTTP server does not start. The MCP server always starts regardless.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ORCHESTRATOR_HTTP_PORT` | yes (to enable) | Port to listen on (e.g. `3000`) |
| `ORCHESTRATOR_CONFIG` | yes (to enable) | Absolute path to `orchestrator.yaml` |
| `ORCHESTRATOR_API_KEY` | recommended | Bearer token; if unset all requests are accepted |

## Endpoints

### `GET /health`

Liveness check. Returns the config path being used.

```
GET /health
Authorization: Bearer <api-key>

200 OK
{ "status": "ok", "configPath": "/path/to/orchestrator.yaml" }
```

### `POST /run`

Start a new orchestration. Returns immediately with the `runId`.

```
POST /run
Content-Type: application/json
Authorization: Bearer <api-key>

{
  "task": "Onboard new employee María García as Senior Developer",
  "flow_id": "onboarding-empleado",       // optional
  "payload": {                            // optional, for static flows
    "nombre": "María García",
    "puesto": "Senior Developer",
    "area": "Engineering",
    "fecha_ingreso": "2026-07-01",
    "modalidad": "hybrid",
    "remuneracion": "$5,000/month"
  }
}

202 Accepted
{
  "runId": "run-1751234567890-abc123",
  "status": "running",
  "planSource": "static",
  "subtasks": 4
}
```

### `GET /status/:runId`

Poll run status. Use in a loop (or n8n Wait node) until status is not `running`.

```
GET /status/run-1751234567890-abc123
Authorization: Bearer <api-key>

200 OK
{
  "runId": "run-1751234567890-abc123",
  "status": "waiting_gate",
  "task": "Onboard new employee...",
  "startedAt": "2026-07-01T10:00:00.000Z",
  "completedAt": null,
  "completedSteps": 1,
  "waitingGate": {
    "stepId": "s1-hr-checklist",
    "agentId": "hr-agent",
    "criteria": ["Employee data is complete", "Checklist is appropriate"],
    "output": "...",             // first 1000 chars of agent output
    "requestedAt": "2026-07-01T10:02:30.000Z"
  },
  "finalReport": null,
  "error": null
}
```

### `POST /approve`

Approve or reject a waiting gate. Execution resumes immediately on approval.

```
POST /approve
Content-Type: application/json
Authorization: Bearer <api-key>

{
  "run_id": "run-1751234567890-abc123",
  "approved": true,
  "notes": "Data verified, approved for IT provisioning"
}

200 OK
{
  "runId": "run-1751234567890-abc123",
  "status": "running",
  "stepId": "s1-hr-checklist"
}
```

## n8n integration pattern

A typical n8n workflow for event-driven orchestration:

```
[HR System webhook]
    ↓
[n8n HTTP node] POST /run
    { task, flow_id, payload }
    → runId
    ↓
[n8n Wait / Loop] GET /status/:runId  (every 30s)
    until status ≠ "running"
    ↓
[n8n Switch]
  ├── waiting_gate → [Slack notification to manager]
  │                      ↓
  │                  [Manager clicks Approve in Slack]
  │                      ↓
  │                  [n8n HTTP node] POST /approve { approved: true }
  │                      ↓
  │                  [back to Wait loop]
  │
  ├── complete → [Send welcome email / Update HRIS]
  │
  └── failed → [Alert operations team]
```

## Docker compose example

```yaml
services:
  orchestrator:
    image: node:20-alpine
    command: npx -y @backendkit-labs/orchestrator-agent
    environment:
      ORCHESTRATOR_CONFIG: /app/orchestrator.yaml
      ORCHESTRATOR_HTTP_PORT: 3000
      ORCHESTRATOR_API_KEY: ${ORCHESTRATOR_API_KEY}
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY}
      ORCHESTRATOR_DATA_DIR: /data
    volumes:
      - ./orchestrator.yaml:/app/orchestrator.yaml:ro
      - ./flows:/app/flows:ro
      - orchestrator-data:/data
    ports:
      - "3000:3000"

volumes:
  orchestrator-data:
```

## Security

- Always set `ORCHESTRATOR_API_KEY` in production
- Restrict the port to internal networks (not exposed to the public internet)
- The API key is passed as `Authorization: Bearer <key>` — HTTPS termination should be handled by a reverse proxy (nginx, Caddy, AWS ALB, etc.)
- Run logs go to stderr — the HTTP error logs include request details for debugging
