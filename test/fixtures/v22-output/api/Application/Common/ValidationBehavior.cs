// Auto-generated.
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using FluentValidation;
using Mediator;

namespace Api.Application.Common;

/// <summary>
/// Mediator pipeline behavior that runs every <see cref="IValidator{TRequest}"/>
/// registered in DI before the handler executes.  On any failure the
/// aggregated <see cref="ValidationException"/> bubbles up to
/// <c>DomainExceptionFilter</c>, which converts it to a 400 envelope
/// carrying <c>{ error, trace_id, failures }</c>.
/// </summary>
public sealed class ValidationBehavior<TRequest, TResponse>
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    private readonly IEnumerable<IValidator<TRequest>> _validators;

    public ValidationBehavior(IEnumerable<IValidator<TRequest>> validators)
    {
        _validators = validators;
    }

    public async ValueTask<TResponse> Handle(
        TRequest message,
        CancellationToken cancellationToken,
        MessageHandlerDelegate<TRequest, TResponse> next)
    {
        if (_validators.Any())
        {
            var ctx = new ValidationContext<TRequest>(message);
            var results = await Task.WhenAll(
                _validators.Select(v => v.ValidateAsync(ctx, cancellationToken)));
            var failures = results
                .SelectMany(r => r.Errors)
                .Where(f => f != null)
                .ToList();
            if (failures.Count > 0) throw new ValidationException(failures);
        }
        return await next(message, cancellationToken);
    }
}
