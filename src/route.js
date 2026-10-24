const LANGUAGE_SEGMENT = /^\/[a-z]{2,3}(?:-[a-z]{4})?(?=\/)/i;

export function siteRoutePath(pathname) {
  return pathname.replace(LANGUAGE_SEGMENT, '');
}

export function routeIdentity(locationObject) {
  const pathname = siteRoutePath(locationObject.pathname || '/');
  const part = new URLSearchParams(locationObject.search || '').get('p') || undefined;
  if (locationObject.hostname === 'www.bilibili.com' && pathname.startsWith('/video/')) {
    return { routeKind: 'video', bvid: pathname.split('/')[2] || undefined, part };
  }
  if (locationObject.hostname === 'www.bilibili.com'
    && (pathname === '/list/watchlater' || pathname.startsWith('/list/watchlater/'))) {
    return { routeKind: 'video', watchLaterItem: pathname.split('/')[3] || undefined, part };
  }
  if (locationObject.hostname === 'live.bilibili.com') {
    return { routeKind: 'live', part };
  }
  return { routeKind: 'other', part };
}
