select k, count() as c from t group by k
having c > 1 -- or c = 0, and k
order by c