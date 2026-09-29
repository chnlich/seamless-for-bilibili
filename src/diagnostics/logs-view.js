// 日志页 CDN 竞速面板的范围语义与文案（logs.js 装配 DOM，测试与检查脚本共用这里）。
// 面板只按单个 session 统计（logs:cdn-summary 必须带 sessionId），而日志页能选的
// session 只有「当前 session」（从弹窗的「打开开发日志」带 #sessionId 进入本页才存在）。
// 选不到 session 时按钮禁用、状态行直说怎样才有 session 可读，不给「请选择一个
// session」这种页面上根本没有可选列表的死路（2026-09-29 实测：无 #sessionId 打开
// 日志页时按钮必报此错，而下拉里只有 全部/当前 两项）。
export const CDN_RANGE_MESSAGES = Object.freeze({
  idle: '尚未读取 CDN racing。',
  noSessionEntry: 'CDN racing 按单个 session 统计：从 Bilibili 视频页或直播页的弹窗里点「打开开发日志」，本页才会带上当前 session。',
  pickCurrent: 'CDN racing 按单个 session 统计：把导出范围切到 当前 session 后读取。',
});

// 选得到 session 时启用并按最近状态显示（lastStatus 缺失退回初始提示）；
// 选不到时禁用并说明路径：范围里有 当前 session 可选就指向它，否则指向弹窗入口。
export function cdnPanelState({ sessionSelected, currentSessionAvailable, lastStatus }) {
  if (sessionSelected === true) {
    return { disabled: false, status: lastStatus ?? CDN_RANGE_MESSAGES.idle };
  }
  return {
    disabled: true,
    status: currentSessionAvailable === true
      ? CDN_RANGE_MESSAGES.pickCurrent
      : CDN_RANGE_MESSAGES.noSessionEntry,
  };
}
