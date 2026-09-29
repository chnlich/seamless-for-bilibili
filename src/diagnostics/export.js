// 导出的分页循环：导出开始时先固定 maxEventId 快照，再逐页读取写出 JSONL 行。
// 读取范围固定为快照；日志清理删除范围内的记录时分页原样跳过，因此导出容忍
// 进行中消失的行，快照之外的新增记录不会进入本次文件。
// 单个 session 的导出走 session 索引分页（logs:session-events-page），代价只随该
// session 自身的大小增长；全库导出仍按全局 eventId 分页（logs:events-page）。

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
  if (sessionId === undefined) {
    let afterEventId = 0;
    for (;;) {
      const response = await send({
        type: 'logs:events-page',
        limit: 250,
        afterEventId,
        maxEventId,
      });
      await callback(response.events);
      if (!response.hasMore) break;
      const nextAfterEventId = response.nextAfterEventId ?? response.events.at(-1)?.eventId;
      if (!Number.isInteger(nextAfterEventId) || nextAfterEventId <= afterEventId) {
        throw new Error('日志分页没有向前推进');
      }
      afterEventId = nextAfterEventId;
    }
    return;
  }
  let afterSequence = 0;
  for (;;) {
    const response = await send({
      type: 'logs:session-events-page',
      limit: 250,
      afterSequence,
      maxEventId,
      sessionId,
    });
    await callback(response.events);
    if (!response.hasMore) break;
    const nextAfterSequence = response.nextAfterSequence;
    if (!Number.isInteger(nextAfterSequence) || nextAfterSequence <= afterSequence) {
      throw new Error('日志分页没有向前推进');
    }
    afterSequence = nextAfterSequence;
  }
}

export async function writeEvents(send, writer, sessionId, maxEventId) {
  await forEachEventPage(send, sessionId, maxEventId, async (events) => {
    for (const event of events) await writeLine(writer, { recordType: 'event', ...event });
  });
}
