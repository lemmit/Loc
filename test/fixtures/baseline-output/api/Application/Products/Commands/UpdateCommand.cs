// Auto-generated.
using Mediator;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;
using Api.Domain.Common;

namespace Api.Application.Products.Commands;

public sealed record UpdateCommand(ProductId Id, string Sku, Money Price) : ICommand;
