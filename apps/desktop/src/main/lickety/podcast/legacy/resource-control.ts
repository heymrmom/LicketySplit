/** Cancellation checkpoint for copied matching/review loops; yields to IPC and timers. */
export async function mediaCheckpoint(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
}
