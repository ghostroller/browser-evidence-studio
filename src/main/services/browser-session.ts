import { randomUUID } from 'node:crypto';
import { ensure } from '@/shared/errors';

/** Owns live browser resources independently of the current evidence writer.
 * A new recording gets a new runtime object; old async work cannot acquire the
 * next recording's store by retaining a reference to the previous runtime.
 */
export class BrowserSessionLifecycle<Runtime extends {id:string;projectId:string;profileId:string}> {
  readonly id = randomUUID();
  recordingId: string | undefined;
  constructor(public runtime: Runtime) { this.recordingId = runtime.id; }
  attach(runtime: Runtime) {
    ensure(!this.recordingId, 'Seal the active recording before attaching another', 409);
    ensure(runtime.projectId === this.runtime.projectId && runtime.profileId === this.runtime.profileId,
      'Close the live browser session before changing project or profile', 409);
    this.runtime = runtime;
    this.recordingId = runtime.id;
  }
  detach(recordingId: string) {
    ensure(this.recordingId === recordingId, 'Recording ownership changed before sealing', 409);
    this.recordingId = undefined;
  }
}
