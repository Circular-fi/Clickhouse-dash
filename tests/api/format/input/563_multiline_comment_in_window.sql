select sum(a) over (
partition by b -- , c or d
order by e) from t