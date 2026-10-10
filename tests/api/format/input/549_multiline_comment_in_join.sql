select * from a
left join b on a.id = b.id -- or a.id = b.parent
where a.x = 1