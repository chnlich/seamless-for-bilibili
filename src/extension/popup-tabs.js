// 弹窗的标签页归属与页面分类。
// 弹窗没有 tabs 权限（manifest 只有 storage 与 unlimitedStorage），标签页地址字段不可见，
// 所以归属用 windowId 判定、页面分类用 chrome.tabs.query 的 url 过滤判定；两者都不读
// 标签页地址字段本身，因而不依赖 tabs 权限。

import { EXTENSION_MANIFEST } from '../constants.js';

// 面板只报告它所附着的那个窗口的活动标签页：chrome.windows.getCurrent() 在弹窗里
// 返回弹窗所属的窗口，在该窗口内取活动标签页。用 lastFocusedWindow 会把面板解析到
// 另一个窗口的活动标签页（2026-09-28 用户实测：两个普通窗口时，弹窗开在直播房间
// 所在窗口，lastFocusedWindow 解析到的却是另一窗口的标签页，面板的来源标注因此被
// 读成对当前窗口的错误判断）。
export async function popupAttachedTab({ windowsApi, tabsApi }) {
  const ownWindow = await windowsApi.getCurrent();
  const tabs = await tabsApi.query({ active: true, windowId: ownWindow.id });
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) return undefined;
  return tabs[0];
}

// 目标标签页是不是增强脚本应存在的页面：chrome.tabs.query 的 url 过滤不需要 tabs
// 权限（权限只影响返回的地址字段，不影响过滤）。地址只与 manifest 内容脚本同一份
// matches 比对。脚本不答而地址匹配时，页面在扩展安装或更新前就已打开：旧文档不会
// 补装脚本（更新还会作废旧脚本），只能刷新页面后恢复。
export async function tabOnEnhancementRoute({ tabsApi, windowId, tabId }) {
  const matches = await tabsApi.query({ url: [...EXTENSION_MANIFEST.matches], windowId });
  return matches.some((tab) => tab.id === tabId);
}
