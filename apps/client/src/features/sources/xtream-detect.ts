/** `http://host:8080/get.php?username=u&password=p&type=m3u_plus` → Xtream credentials. */
export function detectXtream(value: string): { server: string; username: string; password: string } | null {
  try {
    const url = new URL(value.trim());
    if (!/\/get\.php$/i.test(url.pathname)) return null;
    const username = url.searchParams.get('username');
    const password = url.searchParams.get('password');
    if (!username || !password) return null;
    return { server: `${url.protocol}//${url.host}`, username, password };
  } catch {
    return null;
  }
}
