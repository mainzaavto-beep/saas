export const dynamic = 'force-dynamic';
export default function Page() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#8a99b8', fontFamily: 'system-ui' }}>
      <h2 style={{ color: '#e8edf7' }}>Склады и индексы</h2>
      <p>Остатки по складам WB, индексы поставки, оборачиваемость.</p>
      <p style={{ fontSize: 13, color: '#6b7a8f' }}>Полная аналитика появится после накопления истории остатков.</p>
    </div>
  );
}
