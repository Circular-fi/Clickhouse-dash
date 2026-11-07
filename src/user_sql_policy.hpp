#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// ChDash intentionally allows arbitrary SQL supported by runner_uri, except
// direct KILL QUERY statements. Query cancellation is a capability-controlled
// backend action executed via system_uri; allowing runner-side KILL QUERY would
// bypass that boundary because ClickHouse users may cancel their own queries.
bool user_sql_is_forbidden(std::string_view sql);

// The class of the SQL of a run, for the ceilings of a grant (docs/access.md, "Limits of a grant"). A person who holds query.run.read and
// query.run.write gets the ceilings of the action that fits the SQL.
//   Read   every statement only reads: SELECT, WITH ... SELECT, SHOW, DESCRIBE, EXISTS, EXPLAIN and CHECK.
//   Write  one statement at least changes data, the schema, the access or the settings (INSERT, CREATE, ALTER, SET, SYSTEM ...).
//   Unsure the text has a statement that the code does not know, or it has no statement. The caller applies the lower value of each
//          ceiling of the two actions.
// The code cuts the statements at the semicolons of the code and reads the first word of each one with the lexer of ClickHouse
// (sql_lexer.hpp). A SETTINGS clause does not change the class: the backstops of the client keep the ceilings whatever the SQL sets.
enum class SqlStatementClass { Read, Write, Unsure };

SqlStatementClass sql_statement_class(std::string_view sql);
// The class of several texts: Write when one is a Write, else Unsure when one is Unsure (or the list is empty), else Read.
SqlStatementClass sql_statements_class(const std::vector<std::string>& texts);

} // namespace chdash
