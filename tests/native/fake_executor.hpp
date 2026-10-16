#pragma once

// A fake ClickHouse for the native tests. A ChExecutor gives the answers that a test writes.
// The first rule whose text is in a statement gives the answer to that statement.
// Every statement that is sent is kept, with its parameters. There is no server and no connection.

#include "ch_executor.hpp"

#include <clickhouse/columns/numeric.h>
#include <clickhouse/columns/string.h>
#include <clickhouse/exceptions.h>

#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace nt {

using chdash::BoundedRead;
using chdash::ChExecutor;
using chdash::ChParams;

using Row = std::vector<std::string>;
using Rows = std::vector<Row>;


// The first rule whose text is in a statement gives its answer. A rule can answer only a set number of times, or it can throw.
// Every statement is kept, with its parameters.
class FakeDb final : public ChExecutor {
 public:
  struct Rule {
    std::string contains;
    std::function<Rows(const std::string&)> answer;
    std::function<clickhouse::Block(const std::string&)> block;
    std::function<void()> fail;
    int remaining = -1;  // -1: always
  };

  std::vector<std::string> sqls;
  std::vector<ChParams> params;
  std::vector<Rule> rules;
  int invalidated = 0, renewed = 0;
  bool renew_ok = true;
  BoundedRead bounded_result;  // what a bounded statement reports that it read

  void on(const std::string& contains, Rows rows, int times = -1) {
    rules.push_back(Rule{contains, [rows](const std::string&) { return rows; }, {}, {}, times});
  }
  void on_fn(const std::string& contains, std::function<Rows(const std::string&)> answer, int times = -1) {
    rules.push_back(Rule{contains, std::move(answer), {}, {}, times});
  }
  void on_block(const std::string& contains, std::function<clickhouse::Block(const std::string&)> block) {
    rules.push_back(Rule{contains, {}, std::move(block), {}, -1});
  }
  void fail_on(const std::string& contains, std::function<void()> thrower, int times = -1) {
    rules.push_back(Rule{contains, {}, {}, std::move(thrower), times});
  }

  using ChExecutor::select;
  using ChExecutor::bounded_select;

  void select(const std::string& sql, const ChParams& sent, const OnBlock& on_block) override {
    sqls.push_back(sql);
    params.push_back(sent);
    for (auto& rule : rules) {
      if (rule.remaining == 0 || sql.find(rule.contains) == std::string::npos) continue;
      if (rule.remaining > 0) --rule.remaining;
      if (rule.fail) rule.fail();
      if (rule.block) {
        on_block(rule.block(sql));
        return;
      }
      deliver(rule.answer(sql), on_block);
      return;
    }
  }
  BoundedRead bounded_select(const std::string& sql, const OnBlock& on_block, const ChParams& sent) override {
    select(sql, sent, on_block);
    return bounded_result;
  }
  std::string endpoint_name = "fake:9000";
  std::string endpoint() const override { return endpoint_name; }
  void invalidate() override { ++invalidated; }
  bool renew(std::string* error) override {
    ++renewed;
    if (!renew_ok && error) *error = "no more connections";
    return renew_ok;
  }

  size_t count(const std::string& text) const {
    size_t n = 0;
    for (const auto& sql : sqls) n += sql.find(text) != std::string::npos;
    return n;
  }

 private:
  static void deliver(const Rows& rows, const OnBlock& on_block) {
    if (rows.empty()) return;
    clickhouse::Block block;
    for (size_t c = 0; c < rows.front().size(); ++c) {
      auto column = std::make_shared<clickhouse::ColumnString>();
      for (const auto& row : rows) column->Append(row[c]);
      block.AppendColumn("c" + std::to_string(c), column);
    }
    on_block(block);
  }
};

inline clickhouse::ServerException server_error(int code, const std::string& text) {
  auto exception = std::make_shared<clickhouse::Exception>();
  exception->code = code;
  exception->name = "DB::Exception";
  exception->display_text = text;
  return clickhouse::ServerException(exception);
}

// The service gets its connection from a function. Here, the function always returns the same fake.
class ForwardDb final : public ChExecutor {
 public:
  explicit ForwardDb(FakeDb& db) : db_(db) {}
  using ChExecutor::select;
  using ChExecutor::bounded_select;
  void select(const std::string& sql, const ChParams& params, const OnBlock& on_block) override { db_.select(sql, params, on_block); }
  BoundedRead bounded_select(const std::string& sql, const OnBlock& on_block, const ChParams& params) override {
    return db_.bounded_select(sql, on_block, params);
  }
  std::string endpoint() const override { return db_.endpoint(); }
  void invalidate() override { db_.invalidate(); }
  bool renew(std::string* error) override { return db_.renew(error); }

 private:
  FakeDb& db_;
};

}  // namespace nt
