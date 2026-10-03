# ERP Order Management — Phase 1

Standalone ERP built with **Node.js + Express + MongoDB/Mongoose**. The UI is served directly by Express, so there is no separate frontend project or build step.

## Architecture

```text
ERP UI (Express static files)
        |
        | REST API
        v
Node.js + Express
        |
        | Mongoose
        v
MongoDB
```

## Current scope

- ERP shell inspired by modern ERP products
- Orders list
- Search orders
- Filter by status
- Order details
- Create test order
- Update order status
- Delete order
- MongoDB persistence
- REST API
- Seed data
- Health endpoint
- Basic validation
- CORS
- Helmet
- Morgan request logging

## Deliberately not included

- Authentication / authorization
- Payment integration
- Accounting
- Seller management
- Production secrets

The Rafttaar integration (below) lives in the backend. The browser never calls Rafttaar directly.

## Requirements

- Node.js 20 or newer
- MongoDB local installation or MongoDB Atlas

## Run directly in VS Code

### 1. Extract the ZIP

Open the extracted `erp-system` folder in VS Code.

### 2. Install packages

```bash
npm install
```

### 3. Configure MongoDB

Copy the environment file:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env`:

```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb://127.0.0.1:27017/erp_system
```

For MongoDB Atlas, replace `MONGODB_URI` with your Atlas connection string.

### 4. Start

Development mode:

```bash
npm run dev
```

Normal mode:

```bash
npm start
```

Open:

```text
http://localhost:5000
```

Health check:

```text
http://localhost:5000/health
```

## REST API

Base URL:

```text
http://localhost:5000/api
```

### List orders

```http
GET /orders
GET /orders?search=Rahul
GET /orders?status=pending
```

### Get order

```http
GET /orders/:id
```

### Create order

```http
POST /orders
Content-Type: application/json
```

Example:

```json
{
  "orderId": "ORD-20001",
  "customer": {
    "name": "Test Customer",
    "phone": "9876543210",
    "email": "test@example.com"
  },
  "items": [
    {
      "productName": "Demo Product",
      "sku": "DEMO-001",
      "quantity": 2,
      "price": 500
    }
  ],
  "shippingAddress": {
    "addressLine1": "10 Demo Street",
    "city": "Mumbai",
    "state": "Maharashtra",
    "pincode": "400001",
    "country": "India"
  }
}
```

The backend calculates `totalAmount`; clients do not need to send it.

### Update order

```http
PATCH /orders/:id
Content-Type: application/json
```

```json
{
  "status": "processing"
}
```

### Delete order

```http
DELETE /orders/:id
```

## Project structure

```text
erp-system/
├── public/
│   ├── index.html
│   ├── css/
│   │   └── app.css
│   └── js/
│       └── app.js
├── src/
│   ├── controllers/
│   │   └── orderController.js
│   ├── middleware/
│   │   └── errorHandler.js
│   ├── models/
│   │   └── Order.js
│   ├── routes/
│   │   └── orderRoutes.js
│   ├── app.js
│   ├── db.js
│   └── server.js
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Deployment

Deploy the Node.js application and set:

```env
PORT=<platform-provided-port>
NODE_ENV=production
MONGODB_URI=<your MongoDB connection string>
```

The application serves both the UI and API from the same server.

## Future integration

Current:

```text
ERP UI
  ↓
ERP Backend
  ↓
MongoDB
```

Future:

```text
Raftaar Platform
  ↓
Raftaar API / SDK
  ↓
ERP Backend
  ↓
MongoDB
  ↓
ERP UI
```


## Rafttaar integration (Partner API)

The ERP receives orders from Rafttaar and drives them to delivery through the **Rafttaar Partner API**
(`openapi/partner-v1.yaml` in the Rafttaar Partner SDK repo is the contract). It is a **hand-written HTTP
client — the `@rafttaar/partner-sdk` npm package is not used.**

```text
Rafttaar  ──events (poll GET /events  OR  signed webhook POST /webhooks/rafttaar)──▶  ERP
Rafttaar  ◀──acknowledge / confirm / packaging / delay / cancel / invoice / dispatch / inventory / locations──  ERP
```

### Configure (`.env`, or Render env vars)

```env
RAFTTAAR_API_KEY=rtk_test_...            # rtk_test_ = sandbox, rtk_live_ = real (the prefix decides)
RAFTTAAR_BASE_URL=https://raf-api.bellcorpstudio.com/api/v1/central-service/partner/v1
PUBLIC_BASE_URL=https://<public https origin of this ERP>   # ngrok URL locally, Render URL when deployed
RAFTTAAR_WORKERS=on                      # "off" = API only, no poller / outbox worker
```

`PUBLIC_BASE_URL` is needed for two things Rafttaar cannot do against `localhost`: the webhook URL it calls,
and the invoice PDF link it stores. Open **Rafttaar integration** in the sidebar for the control panel
(connection test, sync mode, webhooks, locations, inventory, event log, outbox, sandbox, settings).

### How it works

| Piece | File | Why |
| --- | --- | --- |
| HTTP client (all 25 operations) | `src/integrations/rafttaar/client.js` | bearer auth, `Idempotency-Key` on every write (reused on retry), client-side throttle under the 10 req/s limit, `429`/`Retry-After`, retries only network/5xx/429, typed errors with the stable `code` |
| Event intake | `poller.js`, `webhooks.js`, `eventProcessor.js` | poll `GET /events` **or** receive signed webhooks. Events are stored by unique id (exactly-once), handlers re-read current state from Rafttaar (out-of-order and replays converge), the cursor never skips an event that failed to apply, first connect = reconcile + jump to head, Mongo lease so two instances never poll at once |
| Webhook security | `signature.js` | HMAC-SHA256 over the **raw** body, constant-time compare, 300s replay window, accepts the two-secret header during the 24h after a rotation |
| Outbound actions + outbox | `actions.js` | each action is stored with its idempotency key *before* it is sent; if Rafttaar/the network fails it is retried later with the same key, so a shipment is never double-booked. Business refusals (4xx) are final and shown with Rafttaar's code |
| Invoices | `invoiceBuilder.js` | GST lines allocated so they sum exactly to Rafttaar's order totals (largest remainder), CGST+SGST vs IGST by state, per-financial-year numbering, PDF generated here and served at a public unguessable URL |
| Locations / inventory | `masterData.js` | upsert by the ERP's own warehouse code, carrier status refresh, stock in batches of 500 with a per-item result stored |
| Reconcile | `orderSync.js` | `GET /orders` is the source of truth; run on first connect and any time a webhook may have been missed |

Orders keep Rafttaar's exact state in `order.rafttaar.fulfilmentState`; `order.status` is the ERP's own coarser
view. Orders from Rafttaar cannot be edited through `PATCH /api/orders/:id` — use the Rafttaar actions.

### ERP endpoints added

- `GET /api/rafttaar/status[?live=true]`, `POST /api/rafttaar/connection/test`, `PATCH /api/rafttaar/settings`
- `POST /api/rafttaar/sync/{poll,reconcile,bootstrap}`, `GET /api/rafttaar/{events,actions}`
- Webhooks: `GET/POST /api/rafttaar/webhooks[/register]`, `PATCH/DELETE /:id`, `POST /:id/{rotate-secret,test-event}`, `GET /:id/deliveries`, `POST /:id/deliveries/:deliveryId/resend`
- Sandbox: `POST /api/rafttaar/sandbox/orders`, `POST /api/rafttaar/sandbox/shipments/:id/advance`
- Orders: `POST /api/orders/:id/rafttaar/{acknowledge,status,cancel,dispatch,refresh,invoice,invoice/void}`, `GET .../{invoice,shipment,shipment/label}`
- `GET|PUT /api/locations[/:externalId]`, `POST /api/locations/{refresh,:externalId/sync,:externalId/deactivate}`
- `GET|PUT /api/inventory`, `POST /api/inventory/sync`
- Public: `POST /webhooks/rafttaar` (signature-verified), `GET /invoices/:token.pdf`

### Test

```bash
npm test      # unit + end-to-end against an in-process mock of the Partner API and a throw-away Mongo DB (erp_system_test)
```

### Findings from running against the real API (rtk_test_ key)

- `PUT /locations/{id}` and `PUT /inventory` answer `LIVE_ONLY` for `rtk_test_` keys (not stated in the spec) — they need a live key.
- Sandbox orders cannot be dispatched (`SANDBOX_ORDER_CANNOT_DISPATCH`); simulate carrier progress with the sandbox advance call.
- A seller whose invoices are issued by Rafttaar gets `INVOICE_LOCKED` on `POST .../invoice` — Rafttaar invoices at dispatch.
- The event log (`seq`) is global across sellers, so the first poll of a fresh integration starts mid-sequence.
