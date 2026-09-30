-- keep the view definition in sync
create or replace view checkout_errors as select service_name, count() as errors from otel.traces where status_code = 'Error' group by service_name