SELECT
    block,
    data[1].1  AS signature,
    data[1].2  AS index,
    data[1].3  AS markets,
    data[1].4  AS atom_cu_price,
    data[1].11 AS atom_cu_limit,
    data[1].12 AS atom_cu_used,
    data[1].5  AS atom_gross_gains,
    data[1].6  AS atom_input_amount,
    data[1].7  AS atom_fees,
    data[1].8  AS id,
    data[1].9  AS sub_id,
    data[1].10 AS dark_tip_percent,
    data[1].13 AS atom_cu_price_used,
    data[1].14 AS atom_darktips,
    data[1].15 AS atom_amms
FROM blocks_markets