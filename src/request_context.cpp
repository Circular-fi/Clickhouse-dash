#include "request_context.hpp"

namespace chdash {

thread_local RequestScope* RequestScope::current_ = nullptr;

RequestScope::RequestScope(RequestContext context)
    : context_(std::move(context)), previous_(current_), statements_(context_.limits) {
  current_ = this;
}

RequestScope::~RequestScope() { current_ = previous_; }

const RequestContext& current_request_context() {
  static const RequestContext outside;
  return RequestScope::current_ ? RequestScope::current_->context_ : outside;
}

} // namespace chdash
