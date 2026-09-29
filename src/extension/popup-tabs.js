// 弹窗的标签页归属。
// 弹窗没有 tabs 权限（manifest 只有 storage 与 unlimitedStorage），标签页地址字段
// 不可见，chrome.tabs.query 的 url 过滤同样返回不到任何标签页（实测 Chrome 154：
// 无权限时按 url 过滤恒为空）；归属因此只能用 windowId 判定。

// 面板只报告它所附着的那个窗口的活动标签页：chrome.windows.getCurrent() 在弹窗里
// 返回弹窗所属的窗口，在该窗口内取活动标签页。用 lastFocusedWindow 会把面板解析到
// 另一个窗口的活动标签页（用户实测：两个普通窗口时，弹窗开在直播房间
// 所在窗口，lastFocusedWindow 解析到的却是另一窗口的标签页，面板的来源标注因此被
// 读成对当前窗口的错误判断）。
export async function popupAttachedTab({ windowsApi, tabsApi }) {
  const ownWindow = await windowsApi.getCurrent();
  const tabs = await tabsApi.query({ active: true, windowId: ownWindow.id });
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) return undefined;
  return tabs[0];
}
