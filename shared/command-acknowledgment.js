export function commandAcknowledgment(component, config = {}, commandTargetValue) {
  const timeoutMs = Math.max(1000, Math.min(30000, Number(component?.properties?.ackTimeoutMs || config.commandTimeoutMs || 5000)))
  const feedbackTagId = component?.properties?.feedbackTagId
  const expectedTarget = component?.type === 'operation-shifter' && commandTargetValue && typeof commandTargetValue === 'object'
    ? commandTargetValue.mode
    : commandTargetValue

  // A component-level readback is stronger than a connector-wide transport
  // acknowledgment. It also lets existing Node-RED/PLC flows use one-way RPC
  // while the worker waits for the actual process telemetry to match.
  if (feedbackTagId) {
    return {
      mode: 'feedback-tag',
      tagId: feedbackTagId,
      expectedValue: component.properties?.expectedFeedbackValue ?? expectedTarget,
      timeoutMs,
    }
  }

  if (config.rpcMode === 'two-way') return { mode: 'two-way', timeoutMs }
  return null
}

export function commandAcknowledgmentTimeout(mode, receipt = null) {
  const feedback = mode === 'feedback-tag'
  return {
    commandHealth: {
      state: 'unverified',
      message: feedback
        ? 'Process feedback did not match before timeout; command outcome is unverified.'
        : 'RPC acknowledgment timed out; command outcome is unverified.',
    },
    command: {
      status: 'timeout',
      message: feedback
        ? 'Command feedback timed out; outcome is unverified.'
        : 'Command acknowledgment timed out; outcome is unverified.',
      result: receipt ? { receipt } : {},
    },
  }
}
