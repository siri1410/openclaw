import { drainStoreWriterQueuesForTest } from "../../../test/helpers/promise.js";
import { drainOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { WRITER_QUEUES } from "./store-writer-state.js";

export async function drainSessionStoreWriterQueuesForTest(): Promise<void> {
  await drainStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
  await drainOpenClawAgentWriteAdmission();
}
