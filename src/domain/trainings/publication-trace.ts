export type PublicationTriggerSource = 'cron' | 'manual_admin' | 'startup_recovery';

export type PublicationTrace = {
    jobId?: string;
    publicationAttemptId?: string;
    triggerSource: PublicationTriggerSource;
};

export function publicationTraceFields(trace: PublicationTrace | undefined): Record<string, unknown> {
    return trace ? { jobId: trace.jobId, publicationAttemptId: trace.publicationAttemptId, triggerSource: trace.triggerSource } : {};
}
