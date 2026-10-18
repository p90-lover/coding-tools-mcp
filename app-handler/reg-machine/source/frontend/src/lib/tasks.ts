export const TASK_STATUS_VARIANTS: Record<string, any> = {
  pending: 'secondary',
  claimed: 'secondary',
  running: 'default',
  succeeded: 'success',
  failed: 'danger',
  interrupted: 'warning',
  paused: 'warning',
  cancel_requested: 'warning',
  cancelled: 'warning',
}

export const TERMINAL_TASK_STATUSES = new Set([
  'succeeded',
  'failed',
  'interrupted',
  'paused',
  'cancelled',
])

export type VerificationHold = {
  active: boolean
  code: string
  reason: string
  detected_at: string
  account_id?: number
  account_exists?: boolean
  retry_after_until?: string
}

export function getVerificationRecoveryParams(accountId: number, hold: VerificationHold | null) {
  if (!hold?.active) return {}
  return hold.account_id === accountId ? { resume_verification_hold: true } : null
}

export function isTerminalTaskStatus(status: string) {
  return TERMINAL_TASK_STATUSES.has(status)
}

export function getTaskStatusText(status: string) {
  switch (status) {
    case 'succeeded':
      return '已完成'
    case 'failed':
      return '失败'
    case 'paused':
      return '手机验证暂停'
    case 'interrupted':
      return '已中断'
    case 'cancelled':
      return '已取消'
    case 'cancel_requested':
      return '取消中'
    case 'running':
      return '执行中'
    case 'claimed':
      return '已领取'
    case 'pending':
      return '排队中'
    default:
      return status
  }
}
