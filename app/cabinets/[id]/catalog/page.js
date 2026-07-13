export const dynamic = 'force-dynamic';
export default function Page() {
  return (
    <div style={{ padding: 40, textAlign: 'center', color: '#8a99b8', fontFamily: 'system-ui' }}>
      <h2 style={{ color: '#e8edf7' }}>Справочник товаров</h2>
      <p>Внутренний справочник: связывает SKU WB/Ozon с внутренними товарами компании.</p>
      <p style={{ fontSize: 13, color: '#6b7a8f' }}>Полная функциональность будет перенесена в следующей итерации.</p>
    </div>
  );
}
