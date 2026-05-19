# Expense workflow — user flows

Diagrams for the expenses feature introduced in PR #29.

## 1. Expense lifecycle (state machine)

```mermaid
stateDiagram-v2
    [*] --> pending_approval: request_expense
    [*] --> submitted_retro: submit_retrospective_expense

    pending_approval --> receipt_pending: approve_expense
    pending_approval --> receipt_pending: modify_expense
    pending_approval --> denied: deny_expense
    pending_approval --> cancelled: cancel_expense

    submitted_retro --> approved_retro: approve_expense
    submitted_retro --> denied_retro: deny_expense
    submitted_retro --> cancelled: cancel_expense

    receipt_pending --> receipt_submitted: submit_receipt
    receipt_pending --> cancelled: cancel_expense

    receipt_submitted --> reimbursed: process_reimbursement
    approved_retro --> reimbursed: process_reimbursement

    denied --> [*]
    denied_retro --> [*]
    cancelled --> [*]
    reimbursed --> [*]
```

## 2. Prospective (preferred) happy path

```mermaid
sequenceDiagram
    actor R as Requester
    participant S as Breadbrich Engels
    participant H as Host IPC
    actor A as Approver (coordinator/admin)
    actor F as Finance

    R->>S: "I need $450 for catering"
    S->>H: request_expense
    H->>H: createExpense (pending_approval)
    H-->>A: Notify main group<br/>"New prospective expense exp-…<br/>reply approve / deny / modify"

    A->>S: "approve exp-…"
    S->>H: approve_expense
    H->>H: tier check + not-self-approval
    H->>H: status → receipt_pending
    H-->>R: "Expense approved. Submit a receipt after you spend."

    R->>R: makes purchase
    R->>S: "here's the receipt, actual $447"
    S->>H: submit_receipt
    H->>H: requester check<br/>status → receipt_submitted
    H-->>F: Notify main<br/>"receipt received, ready to reimburse"
    H-->>A: (only if delta) "actual $447 vs approved $450"

    F->>S: "reimbursed via venmo"
    S->>H: process_reimbursement
    H->>H: finance-tag check<br/>status → reimbursed
    H-->>R: "Reimbursement processed via venmo"
```

## 3. Retrospective (discouraged) path

```mermaid
sequenceDiagram
    actor R as Requester
    participant S as Breadbrich Engels
    participant H as Host IPC
    actor A as Admin (approver)
    actor F as Finance

    R->>S: "I already spent $38 on ink, here's the receipt"
    S-->>R: ⚠ "Prospective requests are preferred.<br/>Please loop in an approver next time."
    S->>H: submit_retrospective_expense<br/>(requires justification + receipt_path)
    H->>H: createExpense (submitted_retro)
    H-->>A: Notify main<br/>"New RETROSPECTIVE expense exp-…<br/>reply approve / deny"

    alt approved
        A->>S: "approve exp-…"
        S->>H: approve_expense
        H->>H: admin-only check<br/>status → approved_retro
        H-->>R: "Expense approved."
        H-->>F: "Retrospective approved — please reimburse"
        F->>S: "reimbursed"
        S->>H: process_reimbursement
        H-->>R: "Reimbursement processed"
    else denied
        A->>S: "deny exp-…: reason"
        S->>H: deny_expense
        H->>H: status → denied_retro
        H-->>R: "Expense denied — reason"
    end
```

## 4. Modify, deny, and cancel variants

```mermaid
sequenceDiagram
    actor R as Requester
    participant S as Breadbrich Engels
    participant H as Host IPC
    actor A as Approver

    Note over R,A: Modify (prospective only)
    A->>S: "approve exp-… at $400"
    S->>H: modify_expense (approved_amount_cents required)
    H->>H: validate amount > 0<br/>retrospective? reject
    H->>H: status → receipt_pending<br/>approved_amount_cents = 400
    H-->>R: "Approved at $400 (requested $450).<br/>Submit receipt or cancel."

    Note over R,A: Deny
    A->>S: "deny exp-…: out of budget"
    S->>H: deny_expense
    H->>H: status → denied / denied_retro<br/>resolved_by + resolved_at set
    H-->>R: "Expense denied — out of budget"

    Note over R,A: Cancel (requester only, any non-terminal state)
    R->>S: "cancel exp-…, changed my mind"
    S->>H: cancel_expense (reason)
    H->>H: requester check<br/>not terminal?<br/>status → cancelled
    H-->>R: "Expense cancelled. Reason: changed my mind"
```

## 5. Authorization gates (at-a-glance)

```mermaid
flowchart TD
    Start["IPC message arrives<br/>readSenderContext sourceGroup"] --> Type{message type?}

    Type -->|request / retro| R1[any member]
    R1 --> OK1[createExpense]

    Type -->|approve / deny / modify| Dec{checks}
    Dec --> D1{requester == sender?}
    D1 -->|yes| Block1[❌ self-approval blocked]
    D1 -->|no| D2{tier check}
    D2 -->|coordinator, &lt; $500, prospective| OK2[✅ proceed]
    D2 -->|admin, any amount| OK2
    D2 -->|retrospective not admin| Block2[❌ admin only for retro]
    D2 -->|coordinator, ≥ $500| Block3[❌ above tier]
    OK2 --> D3{modify w/o amount?}
    D3 -->|yes| Block4[❌ reject]
    D3 -->|no| UpdateStatus[updateExpenseApproval]

    Type -->|receipt| Rec{sender == requester?}
    Rec -->|no| Block5[❌ only requester]
    Rec -->|yes & receipt_pending| OK3[attachReceipt]

    Type -->|reimburse| Fin{admin or finance tag?}
    Fin -->|no| Block6[❌ finance only]
    Fin -->|yes & receipt_submitted<br/>or approved_retro| OK4[markReimbursed]

    Type -->|cancel| Can{sender == requester?}
    Can -->|no| Block7[❌ only requester]
    Can -->|yes & not terminal| OK5[cancelExpense + reason]
```
