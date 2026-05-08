// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Products.Commands;

public sealed record CreateProductCommand(string Sku, Money Price) : ICommand<ProductId>;
