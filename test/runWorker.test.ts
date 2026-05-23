import { describe, it, expect, vi, beforeEach } from "vitest";

const sqsSendMock = vi.fn();

vi.mock("@aws-sdk/client-sqs", () => {
  return {
    SQSClient: vi.fn(() => ({ send: sqsSendMock })),
    ReceiveMessageCommand: vi.fn((input) => ({ __cmd: "Receive", input })),
    DeleteMessageCommand: vi.fn((input) => ({ __cmd: "Delete", input }))
  };
});

vi.mock("../src/workers/tryOnWorker", () => ({
  processTryOnJobMessage: vi.fn().mockResolvedValue(undefined)
}));

import { runOnce } from "../src/workers/runWorker";
import { processTryOnJobMessage } from "../src/workers/tryOnWorker";

describe("runWorker.runOnce", () => {
  beforeEach(() => {
    sqsSendMock.mockReset();
    (processTryOnJobMessage as any).mockReset();
    (processTryOnJobMessage as any).mockResolvedValue(undefined);
  });

  it("processes each received message and deletes it on success", async () => {
    sqsSendMock.mockResolvedValueOnce({
      Messages: [
        {
          MessageId: "m1",
          ReceiptHandle: "r1",
          Body: JSON.stringify({
            jobId: "j1",
            userId: "u1",
            userPhotoId: "p1",
            productInputId: "pi1"
          })
        },
        {
          MessageId: "m2",
          ReceiptHandle: "r2",
          Body: JSON.stringify({
            jobId: "j2",
            userId: "u2",
            userPhotoId: "p2",
            productInputId: "pi2"
          })
        }
      ]
    });

    await runOnce({ queueUrl: "https://sqs/x" });

    expect(processTryOnJobMessage).toHaveBeenCalledTimes(2);
    // 1 ReceiveMessageCommand + 2 DeleteMessageCommand = 3 sends
    expect(sqsSendMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT delete a message when processing throws", async () => {
    sqsSendMock.mockResolvedValueOnce({
      Messages: [
        {
          MessageId: "m1",
          ReceiptHandle: "r1",
          Body: JSON.stringify({
            jobId: "j1",
            userId: "u1",
            userPhotoId: "p1",
            productInputId: "pi1"
          })
        }
      ]
    });
    (processTryOnJobMessage as any).mockRejectedValueOnce(new Error("boom"));

    await runOnce({ queueUrl: "https://sqs/x" });

    // 1 ReceiveMessageCommand only — no DeleteMessageCommand
    expect(sqsSendMock).toHaveBeenCalledTimes(1);
  });

  it("returns early when there are no messages", async () => {
    sqsSendMock.mockResolvedValueOnce({ Messages: undefined });
    await runOnce({ queueUrl: "https://sqs/x" });
    expect(processTryOnJobMessage).not.toHaveBeenCalled();
    expect(sqsSendMock).toHaveBeenCalledTimes(1);
  });

  it("does not delete a message with malformed JSON body", async () => {
    sqsSendMock.mockResolvedValueOnce({
      Messages: [{ MessageId: "m1", ReceiptHandle: "r1", Body: "not-valid-json{{" }]
    });

    await runOnce({ queueUrl: "https://sqs/x" });

    // 1 ReceiveMessageCommand only — no DeleteMessageCommand
    expect(sqsSendMock).toHaveBeenCalledTimes(1);
    expect(processTryOnJobMessage).not.toHaveBeenCalled();
  });
});
