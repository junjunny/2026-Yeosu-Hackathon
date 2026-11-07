// A server-validated session is required. Never authorize using localStorage or the role picker.
export const accessConfig = { sessionEndpoint: '' };
export async function managerAccess() {
  if (!accessConfig.sessionEndpoint) return false;
  try {
    const response=await fetch(accessConfig.sessionEndpoint,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok)return false;
    const session=await response.json();
    return session.authenticated===true && session.role==='manager';
  } catch { return false; }
}
