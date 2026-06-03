// Auto-generated.
using System.Threading;
using System.Threading.Tasks;
using Mediator;
using Api.Domain.Products;
using Api.Domain.Common;
using Api.Domain.Ids;
using Api.Domain.ValueObjects;
using Api.Domain.Enums;

namespace Api.Application.Products.Commands;

public sealed class CreateProductHandler : ICommandHandler<CreateProductCommand, ProductId>
{
    private readonly IProductRepository _repo;
    public CreateProductHandler(IProductRepository repo)
    {
        _repo = repo;
    }

    public async ValueTask<ProductId> Handle(CreateProductCommand command, CancellationToken cancellationToken)
    {
        var aggregate = Product.Create(command.Sku, command.Price);
        await _repo.SaveAsync(aggregate, cancellationToken);
        return aggregate.Id;
    }
}
