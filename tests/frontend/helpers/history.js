// The query History lives in IndexedDB (src/static/app_history.js): database "chdash", store "queryHistory", one record for each run.

// Every record, the newest first. Waits for the store to be open and the older localStorage list to be moved in; never
// creates the database (a bare open would make an empty version 1 that the page could not upgrade).
export const historyRecords = (page) => page.evaluate(async () => {
  await window.ChDash.history.ready;
  const databases = await indexedDB.databases();
  if (!databases.some((database) => database.name === 'chdash')) return [];
  return new Promise((resolve) => {
    const request = indexedDB.open('chdash');
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('queryHistory').objectStore('queryHistory').getAll();
      get.onsuccess = () => {
        db.close();
        resolve(get.result.sort((a, b) => b.ts_ms - a.ts_ms));
      };
    };
  });
});
