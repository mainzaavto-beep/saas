export const dynamic = 'force-dynamic';
export default function Page() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#8a99b8', fontFamily: 'system-ui' }}>
      <h2 style={{ color: '#e8edf7' }}>ABC анализ</h2>
      <p>Группировка товаров по выручке: A (топ 80%), B (15%), C (хвост).</p>
      <p style={{ fontSize: 13, color: '#6b7a8f' }}>Будет готов в следующей итерации.</p>
    </div>
  );
}
