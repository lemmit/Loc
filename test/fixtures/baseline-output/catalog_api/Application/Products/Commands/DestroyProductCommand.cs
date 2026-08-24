// Auto-generated.
using Mediator;
using CatalogApi.Domain.Ids;
using CatalogApi.Domain.ValueObjects;
using CatalogApi.Domain.Enums;
using CatalogApi.Domain.Common;

namespace CatalogApi.Application.Products.Commands;

public sealed record DestroyProductCommand(ProductId Id) : ICommand;
