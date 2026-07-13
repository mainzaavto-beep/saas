export const dynamic = 'force-dynamic';
export default function Page() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#8a99b8', fontFamily: 'system-ui' }}>
      <h2 style={{ color: '#e8edf7' }}>Контент</h2>
      <p>Управление контентом товаров (описания, фото, A/B тесты).</p>
      <p style={{ fontSize: 13, color: '#6b7a8f' }}>Требует переноса контент-агента и его БД. Будет доступно позже.</p>
    </div>
  );
}
