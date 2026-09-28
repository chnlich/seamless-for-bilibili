// 导出的分页循环：导出开始时先固定 maxEventId 快照，再逐页读取写出 JSONL 行。
// 读取范围固定为快照；日志清理删除范围内的记录时分页原样跳过，因此导出容忍
// 进行中消失的行，快照之外的新增记录不会进入本次文件。

export async function writeLine(writer, value) {
  await writer.write(`${JSON.stringify(value)}\n`);
}

export async function writeSessions(send, writer, sessionId, maxEventId) {
  let afterSessionId;
  for (;;) {
    const response = await send({
      type: 'logs:sessions-page',
      limit: 250,
      ...(afterSessionId === undefined ? {} : { afterSessionId }),
      maxEventId,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    for (const session of response.sessions) await writeLine(writer, { recordType: 'session', ...session });
    if (sessionId !== undefined || !response.hasMore) break;
    const nextAfterSessionId = response.nextAfterSessionId;
    if (
      typeof nextAfterSessionId !== 'string'
      || nextAfterSessionId.length === 0
      || nextAfterSessionId === afterSessionId
    ) {
      throw new Error('日志 session 分页没有向前推进');
    }
    afterSessionId = nextAfterSessionId;
  }
}

export async function forEachEventPage(send, sessionId, maxEventId, callback) {
  let afterEventId = 0;
  for (;;) {
    const response = await send({
      type: 'logs:events-page',
      limit: 250,
      afterEventId,
      maxEventId,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    await callback(response.events);
    if (!response.hasMore) break;
    const nextAfterEventId = response.nextAfterEventId ?? response.events.at(-1)?.eventId;
    if (!Number.isInteger(nextAfterEventId) || nextAfterEventId <= afterEventId) {
      throw new Error('日志分页没有向前推进');
    }
    afterEventId = nextAfterEventId;
  }
}

export async function writeEvents(send, writer, sessionId, maxEventId) {
  await forEachEventPage(send, sessionId, maxEventId, async (events) => {
    for (const event of events) await writeLine(writer, { recordType: 'event', ...event });
  });
}
