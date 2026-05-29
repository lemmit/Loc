// Auto-generated.
using Mediator;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;

namespace CatalogApi.Application.Products.Commands;

public sealed record UpdateCommand(ProductId Id, string Sku, string Price) : ICommand;
