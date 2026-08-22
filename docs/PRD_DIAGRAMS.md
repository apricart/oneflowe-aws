# OneFlowe — Product Diagrams

All diagrams use [Mermaid](https://mermaid.js.org/) syntax and can be rendered in GitHub, VSCode, or any Mermaid-compatible viewer.

---

## 1. Product Module Diagram

Shows the major modules and how they connect across all three portals.

```mermaid
graph TD
    A[OneFlowe Platform] --> B[Super Admin Portal]
    A --> C[Management Portal]
    A --> D[Order Portal]

    B --> B1[Global Product Catalog]
    B --> B2[Organization Management]
    B --> B3[User Management]
    B --> B4[Role & Permissions]
    B --> B5[Refund Approval]
    B --> B6[Admin Operations]

    C --> C1[Dashboard & Analytics]
    C --> C2[Inventory Management]
    C --> C3[Order Management]
    C --> C4[Budget Management]
    C --> C5[Reports & Exports]
    C --> C6[Branch & User Mgmt]
    C --> C7[Group Management]
    C --> C8[Suppliers]
    C --> C9[Settings]

    D --> D1[Product Catalog Browse]
    D --> D2[Shopping Cart]
    D --> D3[Order Checkout]
    D --> D4[My Orders]
    D --> D5[Receipts]

    B1 --> C2
    C2 --> D1
    C4 --> D3
```

---

## 2. User Role Flow Diagram

Shows which role accesses which part of the system.

```mermaid
graph TD
    Login["/login"] --> SA{Role?}

    SA -->|SUPER_ADMIN| SAP[Super Admin Portal]
    SA -->|HEAD_OFFICE| HOP[Head Office Portal]
    SA -->|BRANCH_ADMIN| BAP[Branch Admin Portal]
    SA -->|ORDER_PORTAL| OP[Order Portal /shop]
    SA -->|EMPLOYEE| OP

    SAP --> SAP1[Organizations]
    SAP --> SAP2[Global Inventory]
    SAP --> SAP3[All Users]
    SAP --> SAP4[All Orders - Approve/Fulfill]
    SAP --> SAP5[All Budgets]
    SAP --> SAP6[Refunds - Approve]
    SAP --> SAP7[All Reports]
    SAP --> SAP8[Roles & Permissions]

    HOP --> HOP1[Org Inventory - Assign]
    HOP --> HOP2[Branch Management]
    HOP --> HOP3[Org Users]
    HOP --> HOP4[Orders - View Only]
    HOP --> HOP5[Budgets - Allocate]
    HOP --> HOP6[Groups]
    HOP --> HOP7[Org Reports]

    BAP --> BAP1[Branch Inventory]
    BAP --> BAP2[Orders - Approve/Reject]
    BAP --> BAP3[Branch Budget - View]
    BAP --> BAP4[Employee Credentials]
    BAP --> BAP5[Refund Requests]
    BAP --> BAP6[Branch Reports]
    BAP --> BAP7[Suppliers]

    OP --> OP1[Browse Products]
    OP --> OP2[Cart & Checkout]
    OP --> OP3[My Orders]
    OP --> OP4[Receipts]
```

---

## 3. Customer / Employee Order Journey

The full path from login to product selection, cart, checkout, and order fulfillment.

```mermaid
flowchart TD
    A([Login to /shop]) --> B[View Budget Status]
    B --> C[Browse Product Catalog]
    C --> D{Find Product?}
    D -->|No| C
    D -->|Yes| E[Select Quantity]
    E --> F{Within Stock?}
    F -->|No| G[Show Out of Stock Warning]
    G --> C
    F -->|Yes| H[Add to Cart]
    H --> I{Continue Shopping?}
    I -->|Yes| C
    I -->|No| J[Open Cart]
    J --> K{Total Within Budget?}
    K -->|No| L[Show Budget Exceeded Warning]
    L --> J
    K -->|Yes| M[Proceed to Checkout]
    M --> N[Review Order Summary]
    N --> O[Place Order]
    O --> P{Server Validation}
    P -->|Stock Insufficient| Q[Error: Refresh Catalog]
    P -->|Budget Exceeded| R[Error: Budget Warning]
    P -->|Success| S[Order Created - PENDING\nBudget Held / Stock Deducted]
    S --> U[View Order in My Orders Tab]
    U --> V{Check Status}
    V -->|PENDING| W[Awaiting Approval]
    V -->|APPROVED| X[Active - Processing]
    V -->|FULFILLED| Y[Order Completed]
    V -->|REJECTED| Z[Cancelled - Reason Shown]
    Y --> AA[Download Receipt]
```

---

## 4. Admin Management Flow

How each admin role manages the system.

```mermaid
flowchart TD
    A([Admin Login]) --> B{Admin Role}

    B -->|SUPER_ADMIN| SA[Super Admin Dashboard]
    B -->|HEAD_OFFICE| HO[Head Office Dashboard]
    B -->|BRANCH_ADMIN| BA[Branch Admin Dashboard]

    SA --> SA1[Manage Organizations]
    SA --> SA2[Manage Global Products]
    SA --> SA3[Assign Products to Orgs]
    SA --> SA4[Manage All Users]
    SA --> SA5[Review Refund Requests]
    SA --> SA6[Fulfill Orders with Token]
    SA --> SA7[View Platform-wide Reports]

    HO --> HO1[Assign Org Products to Branches]
    HO --> HO2[Manage Branches]
    HO --> HO3[Manage Org Users]
    HO --> HO4[Allocate Monthly Budgets]
    HO --> HO5[Create Branch Groups]
    HO --> HO6[View Org-level Reports]
    HO --> HO7[Schedule Automated Reports]

    BA --> BA1[Manage Branch Inventory Visibility]
    BA --> BA2[Approve / Reject Orders]
    BA --> BA3[View Branch Budget]
    BA --> BA4[Manage Employee Credentials]
    BA --> BA5[Submit Refund Requests]
    BA --> BA6[Manage Suppliers]
    BA --> BA7[View Branch Reports]
```

---

## 5. Order Lifecycle Diagram

All possible order status transitions.

```mermaid
stateDiagram-v2
    [*] --> PENDING : Employee submits order\n(stock held, budget held)

    PENDING --> APPROVED : Branch Admin or\nSuper Admin approves\n(approval token generated)

    PENDING --> REJECTED : Branch Admin or\nSuper Admin rejects\n(stock restored, budget released)

    APPROVED --> FULFILLED : Super Admin or\nBranch Admin fulfills\n(token verified, budget spent)

    APPROVED --> REFUNDED : Super Admin processes\nfull refund\n(budget credited)

    FULFILLED --> REFUNDED : Super Admin processes\nfull refund after delivery\n(budget credited)

    FULFILLED --> FULFILLED : Partial refund applied\n(budget partially credited,\norder stays FULFILLED)

    REJECTED --> [*]
    REFUNDED --> [*]
    FULFILLED --> [*]
```

---

## 6. Payment / Invoice / Receipt Flow

How budget, stock, invoice, and refund connect through the order lifecycle.

```mermaid
flowchart TD
    A[Order Created - PENDING] --> B[Budget Held\namountHeldCents +total\nStock Deducted]
    B --> C{Admin Decision}
    C -->|Rejected| D[Release Hold\namountHeldCents -total\nStock Restored]
    C -->|Approved| E[Approval Token Generated\nStored as Hash in DB]
    E --> F{Token Presented at Fulfillment?}
    F -->|Invalid Token| G[Fulfillment Denied\nLogged in System Logs]
    F -->|Valid| H[Order FULFILLED\namountHeldCents -total\namountSpentCents +total]
    H --> I[Receipt Snapshot Exists\nfrom Order Creation Time]
    I --> J[Invoice Number Assigned\nSequential per Organization]
    J --> K[Receipt at /receipts/orderId\nDownloadable PDF]
    K --> L{Refund Requested?}
    L -->|No| M[Order Complete]
    L -->|Yes| N[Refund Request PENDING\nEmail to Super Admin]
    N --> O{Super Admin Approves?}
    O -->|Declined| P[Refund Request Rejected]
    O -->|Approved| Q[amountCreditedCents +refundAmount\nBudget Restored to Branch]
    Q --> R[Refund Items Logged Line by Line\nOrder Status Updated]
    R --> S[Employee Sees Refund in Order Portal]
```

---

## 7. System Context Diagram

OneFlowe and all external systems it depends on.

```mermaid
graph TD
    Users["Users\n(Admin / Branch Admin /\nEmployee / ORDER_PORTAL)"]

    subgraph OneFlowe["OneFlowe Platform (Next.js 15 App Router)"]
        Web["Web Application\n/dashboard /shop /api/v1"]
        Auth["NextAuth.js\nJWT + Revocation Registry\nIdle 1-15m + Absolute 8h"]
        MW["Edge Middleware\nRole Routing + Security Headers"]
    end

    DB["PostgreSQL\n(Drizzle ORM)\nAll Business Data"]
    Redis["Upstash Redis\nMFA OTP State\nRate Limiting"]
    SES["AWS SES\nTransactional Email:\nOTP, Welcome, Tokens,\nRefunds, Reports"]
    S3["AWS S3\nProduct Image Storage"]
    CDN["AWS CloudFront\nImage CDN (inferred)"]
    Cron["Scheduled Tasks\n/api/v1/orders/cron/auto-fulfill\n/api/v1/reports/process-schedules"]

    Users --> MW
    MW --> Auth
    Auth --> Web
    Web --> DB
    Web --> Redis
    Web --> SES
    Web --> S3
    S3 -.-> CDN
    CDN -.-> Users
    Cron --> Web
```
