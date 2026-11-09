/**
 * Sends a pay period's approved hours to Gusto from the browser, one batch per
 * request (a Worker can only make so many requests at once). Used by the Send
 * page and by Today, so both say the same thing about what happened.
 */
import { post } from '@/lib/time-clock/admin-client';

interface BatchResult {
  sent: number;
  remaining: number;
  synced?: boolean;
  syncError?: string;
  inTimeTracking?: boolean;
  warnings?: string[];
  onPayroll?: boolean;
  payrollNotes?: string[];
  fillError?: string;
}

export interface SendOutcome {
  ok: boolean;
  sent: number;
  /** What happened, in a sentence or two. */
  message: string;
  /** Things to check in Gusto, if any. */
  problems: string;
}

export async function sendToGusto(payrollUuid: string, progress: (sent: number) => void): Promise<SendOutcome> {
  let sent = 0;
  const warnings: string[] = [];
  for (;;) {
    progress(sent);
    const { data, error } = await post<BatchResult>('/api/admin/gusto/send/', { payrollUuid });
    if (error || !data) return { ok: false, sent, message: error ?? 'Something went wrong. Try again.', problems: '' };
    sent += data.sent;
    warnings.push(...(data.warnings ?? []));
    if (data.remaining > 0) continue;

    const done = sent ? `Sent ${sent} ${sent === 1 ? 'shift' : 'shifts'}.` : 'Nothing new to send.';
    // Gusto's warnings mean hours landed but something else didn't, so they're shown as problems.
    const problems = [...(warnings.length ? [`Gusto added the hours but warned: ${warnings.join(' ')}`] : []), ...(data.payrollNotes ?? [])].join(' ');
    let message: string;
    if (data.inTimeTracking) {
      if (data.onPayroll) message = `${done} The hours are on the draft payroll in Gusto. Check them there, then submit payroll.`;
      else if (data.fillError)
        message = `${done} They're in Gusto's time tracking, but couldn't go on the payroll: ${data.fillError} In Gusto, open Time tracking and press Sync hours to payroll.`;
      else message = `${done} They're in Gusto's time tracking now. In Gusto, open Time tracking, press Sync hours to payroll, and check the hours before running payroll.`;
    } else {
      message = data.synced
        ? `${done} Gusto is adding the hours to the draft payroll now, so check them there before running it.`
        : `${done} Gusto did not add them to the payroll: ${data.syncError}. Use Sync hours in Gusto's payroll screen.`;
    }
    return { ok: true, sent, message, problems };
  }
}
