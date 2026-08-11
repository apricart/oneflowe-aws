/**
 * Global Security Logger
 * 
 * Logs security-critical events to a dedicated log file.
 * Used for audit trail of approval tokens and fulfillment attempts.
 */

import fs from 'node:fs'
import path from 'node:path'

const LOG_DIR = path.join(process.cwd(), 'logs')
const SYSTEM_LOG_FILE = path.join(LOG_DIR, 'system-audit.log')
const ERROR_LOG_FILE = path.join(LOG_DIR, 'error.log')
const INVENTORY_LOG_FILE = path.join(LOG_DIR, 'inventory-audit.log')
const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_LOG_FILES = 5

export interface LogEntry {
    event: string
    timestamp?: string
    userId?: string
    userEmail?: string
    userRole?: string
    resourceId?: string
    organizationId?: number
    branchId?: number
    result?: 'SUCCESS' | 'FAILED'
    details?: any
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

/**
 * Mask sensitive data in logs
 */
function maskSensitiveData(data: any, seen = new WeakSet()): any {
    if (data === null || data === undefined) {
        return data
    }

    // Handle circular references
    if (typeof data === 'object') {
        if (seen.has(data)) {
            return '[Circular Reference]'
        }
        seen.add(data)
    }

    // Primitive types - check for sensitive patterns
    if (typeof data === 'string') {
        // Don't mask everything, just check if it's a known sensitive field value
        return data
    }

    if (typeof data !== 'object') {
        return data
    }

    // Array handling
    if (Array.isArray(data)) {
        return data.map(item => maskSensitiveData(item, seen))
    }

    // Object handling
    const masked: any = {}
    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'otp', 'pin', 'authorization']

    for (const key of Object.keys(data)) {
        const lowerKey = key.toLowerCase()
        if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
            masked[key] = '***MASKED***'
        } else if (typeof data[key] === 'object' && data[key] !== null) {
            masked[key] = maskSensitiveData(data[key], seen)
        } else {
            masked[key] = data[key]
        }
    }

    return masked
}

/**
 * Ensure log directory exists
 */
function ensureLogDirectory(): void {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true })
        }
    } catch (error) {
        console.error('[Logger] Failed to create log directory:', error)
    }
}

/**
 * Rotate log file if it exceeds max size
 */
function rotateLogFile(logFile: string): void {
    try {
        if (!fs.existsSync(logFile)) {
            return
        }

        const stats = fs.statSync(logFile)
        if (stats.size < MAX_LOG_SIZE) {
            return
        }

        // Rotate logs
        for (let i = MAX_LOG_FILES - 1; i > 0; i--) {
            const oldFile = `${logFile}.${i}`
            const newFile = `${logFile}.${i + 1}`
            if (fs.existsSync(oldFile)) {
                fs.renameSync(oldFile, newFile)
            }
        }

        fs.renameSync(logFile, `${logFile}.1`)
    } catch (error) {
        console.error('[Logger] Failed to rotate log file:', error)
    }
}

/**
 * Write log entry to file
 */
function writeLog(logFile: string, content: string): void {
    try {
        ensureLogDirectory()
        rotateLogFile(logFile)
        fs.appendFileSync(logFile, content, 'utf-8')
    } catch (error) {
        console.error('[Logger] Failed to write log:', error)
    }
}

/**
 * Log a generic system event to the audit file
 */
export function logEvent(entry: LogEntry): void {
    try {
        // Validate required fields
        if (!entry.event || typeof entry.event !== 'string') {
            console.error('[Logger] Invalid log entry: event field is required')
            return
        }

        // Mask sensitive data
        const maskedEntry = {
            ...entry,
            details: entry.details ? maskSensitiveData(entry.details) : undefined,
            timestamp: entry.timestamp || new Date().toISOString(),
        }

        const logLine = JSON.stringify(maskedEntry) + '\n'
        writeLog(SYSTEM_LOG_FILE, logLine)
    } catch (error) {
        console.error('[Logger] Failed to log event:', error)
    }
}

/**
 * Log error with full details
 */
export function logError(error: any, context: string, additionalData?: Record<string, any>): void {
    try {
        const errorEntry = {
            level: 'ERROR' as LogLevel,
            context,
            error: error?.message || error?.toString() || 'Unknown error',
            stack: error?.stack,
            code: error?.code,
            timestamp: new Date().toISOString(),
            data: additionalData ? maskSensitiveData(additionalData) : undefined
        }

        const logLine = JSON.stringify(errorEntry) + '\n'
        writeLog(ERROR_LOG_FILE, logLine)

        // Also log to audit file for important contexts
        if (context.includes('AUTH') || context.includes('PAYMENT') || context.includes('ORDER')) {
            logEvent({
                event: 'ERROR_OCCURRED',
                result: 'FAILED',
                details: errorEntry
            })
        }
    } catch (logError) {
        console.error('[Logger] Failed to log error:', logError)
    }
}

/**
 * Specifically log order activities with full details
 */
export function logOrderActivity(
    action: 'CREATE' | 'APPROVE' | 'FULFILL' | 'CANCEL' | 'REJECT',
    order: any,
    user: { id: string, email: string, role: string }
): void {
    try {
        // Validate inputs
        if (!action || !order || !user) {
            console.error('[Logger] Invalid order activity: missing required fields')
            return
        }

        if (!user.id || !user.email || !user.role) {
            console.error('[Logger] Invalid user data in order activity')
            return
        }

        logEvent({
            event: `ORDER_${action}`,
            userId: user.id,
            userEmail: user.email,
            userRole: user.role,
            resourceId: order.id ? String(order.id) : undefined,
            organizationId: order.organizationId,
            branchId: order.branchId,
            result: 'SUCCESS',
            details: {
                tid: order.tid,
                status: order.status,
                total: order.totalCents,
                items: order.orderItems || [],
                notes: order.notes,
                timestamp: new Date().toISOString()
            }
        })
    } catch (error) {
        logError(error, 'ORDER_ACTIVITY_LOGGING', { action, orderId: order?.id })
    }
}

/**
 * Legacy support for specific token events (optional but kept for internal use)
 */
export function logSecurityEvent(entry: any): void {
    try {
        if (!entry || typeof entry !== 'object') {
            console.error('[Logger] Invalid security event entry')
            return
        }

        logEvent({
            ...entry,
            event: entry.event || 'SECURITY_EVENT'
        })
    } catch (error) {
        logError(error, 'SECURITY_EVENT_LOGGING')
    }
}

export function logTokenGenerated(
    orderId: number,
    tid: string,
    userId: string,
    userEmail: string
): void {
    try {
        // Validate inputs
        if (!orderId || !tid || !userId || !userEmail) {
            console.error('[Logger] Invalid token generation data')
            return
        }

        logEvent({
            event: 'APPROVAL_TOKEN_GENERATED',
            resourceId: String(orderId),
            userId,
            userEmail,
            details: { tid },
            result: 'SUCCESS'
        })
    } catch (error) {
        logError(error, 'TOKEN_GENERATION_LOGGING', { orderId, userId })
    }
}

export function logFulfillmentAttempt(
    orderId: number,
    tid: string,
    userId: string,
    userEmail: string,
    userRole: string,
    success: boolean,
    reason?: string
): void {
    try {
        // Validate inputs
        if (!orderId || !tid || !userId || !userEmail || !userRole) {
            console.error('[Logger] Invalid fulfillment attempt data')
            return
        }

        logEvent({
            event: success ? 'ORDER_FULFILLED_WITH_TOKEN' : 'FULFILLMENT_TOKEN_MISMATCH',
            resourceId: String(orderId),
            userId,
            userEmail,
            userRole,
            result: success ? 'SUCCESS' : 'FAILED',
            details: { tid, reason }
        })
    } catch (error) {
        logError(error, 'FULFILLMENT_ATTEMPT_LOGGING', { orderId, userId, success })
    }
}

/**
 * Get log statistics
 */
export function getLogStats(): { systemLogSize: number; errorLogSize: number; inventoryLogSize: number } | null {
    try {
        return {
            systemLogSize: fs.existsSync(SYSTEM_LOG_FILE) ? fs.statSync(SYSTEM_LOG_FILE).size : 0,
            errorLogSize: fs.existsSync(ERROR_LOG_FILE) ? fs.statSync(ERROR_LOG_FILE).size : 0,
            inventoryLogSize: fs.existsSync(INVENTORY_LOG_FILE) ? fs.statSync(INVENTORY_LOG_FILE).size : 0
        }
    } catch (error) {
        console.error('[Logger] Failed to get log stats:', error)
        return null
    }
}

/**
 * Log inventory-related actions (assignments, removals, updates)
 */
export function logInventoryAction(
    action: 'ASSIGN' | 'REMOVE' | 'UPDATE' | 'CREATE' | 'DELETE',
    entityType: 'BRANCH_ASSIGNMENT' | 'ORGANIZATION_INVENTORY' | 'GLOBAL_INVENTORY',
    user: { id: string; email: string; role: string },
    details: {
        organizationId?: number
        branchId?: number
        productIds?: number[]
        assignmentIds?: number[]
        count?: number
        metadata?: Record<string, any>
    }
): void {
    try {
        if (!action || !entityType || !user) {
            console.error('[Logger] Invalid inventory action: missing required fields')
            return
        }

        const logEntry = {
            event: `INVENTORY_${action}_${entityType}`,
            timestamp: new Date().toISOString(),
            userId: user.id,
            userEmail: user.email,
            userRole: user.role,
            organizationId: details.organizationId,
            branchId: details.branchId,
            result: 'SUCCESS',
            details: {
                productIds: details.productIds,
                assignmentIds: details.assignmentIds,
                count: details.count,
                ...details.metadata
            }
        }

        const logLine = JSON.stringify(logEntry) + '\n'
        writeLog(INVENTORY_LOG_FILE, logLine)

        // Also log to system audit for critical actions
        if (action === 'DELETE' || action === 'REMOVE') {
            logEvent({
                event: logEntry.event,
                userId: user.id,
                userEmail: user.email,
                userRole: user.role,
                organizationId: details.organizationId,
                branchId: details.branchId,
                result: 'SUCCESS',
                details: logEntry.details
            })
        }
    } catch (error) {
        logError(error, 'INVENTORY_ACTION_LOGGING', { action, entityType })
    }
}

