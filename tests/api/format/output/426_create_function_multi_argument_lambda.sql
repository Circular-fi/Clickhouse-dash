CREATE FUNCTION IF NOT EXISTS safe_ratio AS
    (numerator, denominator, fallback) -> if(
        denominator = 0,
        fallback,
        round(numerator / denominator, 4)
    )