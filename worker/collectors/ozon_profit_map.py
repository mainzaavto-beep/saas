"""Классификация строк начислений Ozon по корзинам расчёта прибыли.

Корзины позаказные (unit_number IS NOT NULL, has_unit=True): commission,
services, logistics, acquiring, loyalty. Корзины уровня кабинета
(unit_number IS NULL, has_unit=False): cabinet, promo. Незнакомое НЕ
выбрасывается: позаказное -> services (known=False, «прочие сборы» —
статья «Сборы Ozon», волна 2026-08-25), кабинетное -> cabinet
(known=False); вызывающий код логирует по флагу known.

Откуда взяты перечни ниже — задача 1 плана «переезд финансов Ozon на
методы начислений» (docs/superpowers/specs/2026-08-15-ozon-profit-switch-design.md,
docs/ozon-accrual-reconciliation.md §5), фактический перечень типов снят
запросом

    SELECT accrued_category, a.type_id, t.name, count(*), sum(a.accrued)
      FROM tenant.ozon_accruals a
      LEFT JOIN shared.ozon_accrual_types t ON t.type_id = a.type_id
     GROUP BY 1,2,3 ORDER BY 1,5;

под saas_ro на всей истории начислений (оба кабинета, 1 и 1008,
2025-08..2026-08) — 46 сочетаний (category, type_id). has_unit совпадает
с категорией без исключений на этих данных: POSTING/ITEM — всегда с
unit_number, NON_ITEM — никогда (проверено отдельным запросом с
count(*) FILTER (WHERE unit_number IS NULL/IS NOT NULL)).

При появлении новых типов сторож (check-ozon-profit-invariant, задача 4)
не даст им потеряться молча — см. partial-exit контракт ozon_accruals.py.
"""

# Маркер возвратного отправления (не корзина, отдельная константа) —
# POSTING-типы логистики, которые встречаются только на отправлениях
# возврата/отмены/невыкупа (docs/ozon-accrual-reconciliation.md §5:
# "логистика возврата").
RETURN_TYPE_IDS = {45, 59}          # PickUpPointReturnAcceptance, ReturnFlowLogistic

# Эквайринг — ITEM, единственный код (§5: "Оплата эквайринга").
ACQUIRING_TYPE_IDS = {1}            # Acquiring

# Лояльность — ни один встреченный код за год истории (оба кабинета) не
# соответствует по смыслу отдельной механике лояльности (co-investment
# лояльности живёт внутри commission-блока POSTING, а не отдельным
# type_id — см. §8 разбора: "Выплаты по механикам лояльности" ≡
# coinvestment, это поле строки commission, не отдельный тип). Пусто —
# ожидаемо и предусмотрено брифом.
LOYALTY_TYPE_IDS = set()

# NON_ITEM-продвижение (has_unit=False) — реклама, уже учтена ad_spend
# Performance API (worker/collectors/ozon_efficiency.py,
# tenant.ozon_daily_campaign_ad): недоклассифицировать в 'cabinet' =
# двойной счёт рекламы.
#   41 PayPerClick             "Оплата за клик"       — CPC-реклама (трафареты и т.п.)
#   54 Promotion               "Продвижение товара"   — продвижение с оплатой за заказ
#   33 Marketing               "Рекламные услуги"     — реклама явным текстом в описании
NONITEM_PROMO_TYPE_IDS = {41, 54, 33}

# ITEM-типы позаказных СЕРВИСОВ (не перевозка): статья «Сборы Ozon».
# До волны services (2026-08-25) жили в PER_ORDER_LOGISTICS_TYPE_IDS —
# маскировались под логистику (находка владельца: FirstCustomerReview
# 1 813 ₽ выглядел «космической логистикой» отправления 50588097-1427-1).
PER_ORDER_SERVICE_TYPE_IDS = {
    74,   # StarsMembership — звёздные товары
    22,   # Installment — рассрочка
    71,   # SellerReturns — вывоз товара со склада силами Ozon
    116,  # FirstCustomerReview — сбор первых отзывов
    79,   # TemporaryPlacementsAgent — временное размещение товара партнёрами
    15,   # Disposal — утилизация
    78,   # TemporaryPlacement — краткосрочное размещение возврата FBS
    39,   # PackingFee — упаковка товара партнёрами
    38,   # PackageCost — обеспечение материалами для упаковки товара
}

# Позаказные типы (has_unit=True), кроме комиссии (type_id IS NULL на
# POSTING), эквайринга и сервисов (PER_ORDER_SERVICE_TYPE_IDS) — строго
# перевозка/обработка отправлений и возвратов (11 POSTING-типов). Сервисы
# и незнакомые позаказные типы больше сюда не попадают — см.
# PER_ORDER_SERVICE_TYPE_IDS/бакет 'services' в classify_row.
PER_ORDER_LOGISTICS_TYPE_IDS = {
    32,   # Logistic — логистика
    29,   # LastMileCourier — доставка до места выдачи
    98,   # DeliveryToHandoverPlaceByOzon — доставка до места выдачи силами Ozon
    45,   # PickUpPointReturnAcceptance — обработка возвратов/отмен/невыкупов (= RETURN_TYPE_IDS)
    59,   # ReturnFlowLogistic — обратная логистика (= RETURN_TYPE_IDS)
    16,   # Drop-Off — обработка отправления Drop-off
    17,   # Drop-Off Agent — обработка отправления Drop-off партнёрами
    30,   # LastMilePickUpPoint — выдача товара
    9,    # ClientReturn — обработка возвратов
    40,   # PartialReturn — обработка частичного невыкупа
    6,    # Cancellation — обработка отменённых и невостребованных товаров
}

# NON_ITEM-типы уровня кабинета (has_unit=False), кроме продвижения
# (NONITEM_PROMO_TYPE_IDS) — расходы/доходы кабинета, не привязанные к
# конкретному отправлению: складские и логистические сервисы realFBS,
# страхование, отзывы, компенсации, доход от доставки и т.п.
KNOWN_CABINET_TYPE_IDS = {
    64,  # RfbsDomesticDelivery — доставка партнёром Ozon (realFBS)
    52,  # PremiumSubscription — подписка Premium (доля продавца в программе Ozon Premium,
         #                        не campaign-реклама Performance API)
    12,  # CrossDock — кросс-докинг
    27,  # LabelOriginal — бейдж "Оригинал"
    46,  # Placements — размещение товаров на складах Ozon
    76,  # StockInsurance — страхование товара от массовых повреждений
    14,  # DefectRate — обработка операционных ошибок продавца
    77,  # SupplyInbound — обработка товара (приёмка на склад)
    50,  # PremiumMailingCommission — бонусы продавца, рассылка (не CPC/CPO campaign-реклама)
    93,  # DefectFineErrors — превышение индекса ошибок
    61,  # ReviewsPin — закрепление отзыва
    63,  # RfbsDomesticAgentFee — агентское вознаграждение Ozon Агрегатор realFBS
    47,  # PointsForReviews — баллы за отзывы
    96,  # AcceleratedReviewCollection — ускоренный сбор отзывов
    68,  # RfbsServiceFee — сервисный сбор за интеграцию с логистической платформой
    58,  # Replenishment — перемещение товаров между складами Ozon
    72,  # SetOff — взаимозачёт требований между договорами
    10,  # Compensation — компенсация
    57,  # RealizationReportCorrection — корректировка стоимости услуг
    25,  # ItemCompensation — товарная компенсация
    62,  # RfbsClientDeliveryCharge — перечисление за доставку от покупателя (доход, роль
         #                             "доход от доставки", §5 обновление задачи 5)
}


def classify_row(category, type_id, has_unit):
    """-> (bucket, known). bucket: commission|services|logistics|acquiring|loyalty|cabinet|promo.

    category — accrued_category строки ('POSTING'|'ITEM'|'NON_ITEM'),
    type_id — код типа операции (int|None), has_unit — есть ли у строки
    unit_number (номер отправления).
    """
    if category == "POSTING" and type_id is None:
        return "commission", True
    if type_id in ACQUIRING_TYPE_IDS:
        return "acquiring", True
    if type_id in LOYALTY_TYPE_IDS:
        return "loyalty", True
    if not has_unit:
        if type_id in NONITEM_PROMO_TYPE_IDS:
            return "promo", True
        return "cabinet", type_id in KNOWN_CABINET_TYPE_IDS
    if type_id in PER_ORDER_SERVICE_TYPE_IDS:
        return "services", True
    if type_id in PER_ORDER_LOGISTICS_TYPE_IDS:
        return "logistics", True
    # Незнакомый позаказный тип: копилка «прочие сборы» (до волны services —
    # logistics). Незнакомое по-прежнему не теряется, но логистика больше
    # не пухнет от чужих операций.
    return "services", False
